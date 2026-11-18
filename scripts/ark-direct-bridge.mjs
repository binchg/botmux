/** 为 Botmux 的独立方舟配置适配 Responses，使用本机授权模型目录和私有密钥文件。 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 凭据仅从当前用户持有的私有文件读取，路径参数不包含密钥。 */
async function secret(path) {
  const info = await stat(path);
  if (!isAbsolute(path) || !info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error('private_credential_file_required');
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!token || /\s/.test(token)) throw new Error('invalid_private_credential');
  return token;
}

/** 只接受精确授权模型和预先核验的 HTTPS 数据面，不消费请求者提供的地址。 */
function verifyConfig(config) {
  const upstream = new URL(config.upstream);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || !isAbsolute(config.adapterDir) || !Array.isArray(config.models) || !config.models.length
    || config.models.some(row => !/^[\w.-]{1,100}$/.test(row.id) || !/^ep-[\w-]+$/.test(row.endpoint)
      || !['google-interactions', 'openai-chat'].includes(row.protocol) || /gpt[-_.]?6[-_.]1/i.test(row.id))
    || new Set(config.models.map(row => row.id)).size !== config.models.length) throw new Error('invalid_ark_bridge_config');
  return upstream.origin;
}

/** 纯文本和客户端工具结果转换；不丢弃未支持的图片或附件。 */
function parts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content == null) return [];
  if (!Array.isArray(content) || content.some(item => item.type !== 'text' || typeof item.text !== 'string')) {
    throw new Error('ark_direct_text_only');
  }
  return content;
}

/** 无状态 Google 接续需要原样回传带签名的步骤，避免把签名塞进可见正文。 */
function googleRequest(prepared, model) {
  const chat = prepared.request, input = [], system = [], calls = new Map();
  for (const message of chat.messages) {
    if (message.role === 'system') system.push(parts(message.content).map(p => p.text).join('\n'));
    if (message.role === 'user') input.push({ type: 'user_input', content: parts(message.content) });
    if (message.role === 'assistant') {
      const saved = message.ark_steps ? JSON.parse(message.ark_steps) : undefined;
      if (saved && !Array.isArray(saved)) throw new Error('invalid_ark_handoff_steps');
      if (!saved && message.tool_calls?.length) throw new Error('missing_ark_tool_signature');
      for (const call of message.tool_calls ?? []) calls.set(call.id, call.function.name);
      if (saved) input.push(...saved);
      else if (message.content) input.push({ type: 'model_output', content: parts(message.content) });
    }
    if (message.role === 'tool') {
      const name = calls.get(message.tool_call_id);
      if (!name) throw new Error('unknown_ark_tool_result');
      input.push({ type: 'function_result', name, call_id: message.tool_call_id, result: parts(message.content) });
    }
  }
  const tools = (chat.tools ?? []).map(tool => ({ type: 'function', ...tool.function }));
  return { model, input, store: false, stream: false, ...(tools.length && chat.tool_choice !== 'none' ? { tools } : {}),
    ...(system.length ? { system_instruction: system.join('\n\n') } : {}) };
}

/** 将验证过的 Google 工具步骤交给现有 Chat 适配器，保留签名和调用 ID。 */
function googleAnswer(body) {
  if (body.status !== 'completed' && body.status !== 'requires_action') throw new Error('ark_interaction_incomplete');
  if (!Array.isArray(body.steps)) throw new Error('missing_ark_interaction_steps');
  const text = body.steps.filter(step => step.type === 'model_output')
    .flatMap(step => step.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  const calls = body.steps.filter(step => step.type === 'function_call').map(step => ({
    type: 'function', id: step.id, function: { name: step.name, arguments: JSON.stringify(step.arguments ?? {}) },
  }));
  if (!text && !calls.length) throw new Error('ark_interaction_without_output');
  return Response.json({ model: body.model, usage: body.usage, choices: [{
    finish_reason: calls.length ? 'tool_calls' : 'stop',
    message: { role: 'assistant', content: text, tool_calls: calls, ark_steps: JSON.stringify(body.steps) },
  }] });
}

/** 检查引用和大小后读取本地 app-server 发来的 JSON，不记录请求正文。 */
async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error('ark_direct_body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const configPath = process.argv[2];
if (!configPath || !isAbsolute(configPath)) throw new Error('absolute_bridge_config_required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const origin = verifyConfig(config);
const localToken = Buffer.from(await secret(config.localTokenFile));
await secret(config.apiKeyFile);
const { responsesToChat, adaptChatResponse } = await import(pathToFileURL(join(config.adapterDir, 'llmbox-chat.js')).href);
const { catalogForModels } = await import(pathToFileURL(join(config.adapterDir, 'llmbox-catalog.js')).href);
const catalog = catalogForModels(new Map(config.models.map(row => [row.id, row.id])));
for (const model of catalog.models) {
  model.display_name = config.models.find(row => row.id === model.slug)?.displayName ?? model.slug;
  model.shell_type = 'unified_exec';
  model.apply_patch_tool_type = 'freeform';
  model.input_modalities = ['text'];
}

/** 回环服务仅接受隔离 Codex 的本地令牌，方舟密钥不经过 Codex 或 Botmux。 */
const server = createServer(async (req, res) => {
  const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  const pathname = (req.url ?? '/').split('?', 1)[0];
  if (req.method === 'GET' && pathname === '/health') return reply(200, { service: 'botmux-ark-direct', ready: true });
  const presented = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /i, ''));
  if (presented.length !== localToken.length || !timingSafeEqual(presented, localToken)) return reply(401, { error: { code: 'local_auth_required' } });
  if (req.method === 'GET' && pathname === '/codex/models') return reply(200, { models: catalog.models });
  if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(pathname)) return reply(404, { error: { code: 'unknown_route' } });
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  try {
    const body = await readBody(req);
    const selected = config.models.find(row => row.id === body.model);
    if (!selected) return reply(404, { error: { code: 'ark_model_not_configured' } });
    const compact = pathname.endsWith('/compact');
    const prepared = responsesToChat(body, selected.endpoint, { compact });
    const google = selected.protocol === 'google-interactions';
    const wire = google ? googleRequest(prepared, selected.endpoint) : prepared.request;
    const result = await fetch(origin + (google ? '/api/google/interactions' : '/api/v3/chat/completions'), {
      method: 'POST', headers: { authorization: 'Bearer ' + await secret(config.apiKeyFile), 'content-type': 'application/json' },
      body: JSON.stringify(wire), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
    });
    if (!result.ok) {
      const error = await result.json().catch(() => ({}));
      const code = typeof error.error?.code === 'string' && /^[\w.-]{1,96}$/.test(error.error.code) ? error.error.code : 'ark_upstream_error';
      return reply(result.status, { error: { code, message: `Ark HTTP ${result.status} ${code}` } });
    }
    const response = await adaptChatResponse(google ? googleAnswer(await result.json()) : result, body, prepared);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
    if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if (!res.destroyed) {
      const localCode = /^ark_direct_|^unknown_ark_|^missing_ark_/.test(error?.message ?? '') ? error.message : 'ark_adapter_failed';
      reply(502, { error: { code: localCode, message: localCode } });
    }
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 5000;
server.listen(config.port, '127.0.0.1', () => console.log('Botmux Ark direct bridge ready'));
