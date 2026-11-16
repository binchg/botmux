/** 用真实 app-server 验证工具读取、连续追问和可选接续；运行数据隔离且不发飞书消息。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionModelStatus } from '../src/services/session-model-store.js';
import { TRAEX_MODEL_ORDER } from '../src/services/traex-adaptive-model.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'botmux-traex-live-'));
const sessionId = `traex-smoke-${randomUUID()}`;
const token = `TRAEX_SMOKE_${randomUUID()}`;
const fallback = process.argv.includes('--fallback');
const source = process.argv.includes('--source');
const models = process.argv.includes('--models') ? process.argv[process.argv.indexOf('--models') + 1] : TRAEX_MODEL_ORDER.join(',');
if (!models || !/^[\w.,-]+$/.test(models)) throw new Error('invalid_smoke_models');
const expectedExecutor = process.argv.includes('--expect-executor') ? process.argv[process.argv.indexOf('--expect-executor') + 1] : undefined;
const env: NodeJS.ProcessEnv = { ...process.env, SESSION_DATA_DIR: dir, TRAEX_APP_SERVER_DEFAULT: '1',
  TRAEX_ADAPTIVE_MODELS: models, TRAEX_ADAPTIVE_ENABLED: '1' };
// 隔离上层话题身份，避免测试进程被当成真实会话的消息发送者。
for (const key of ['BOTMUX_SESSION_ID', 'CODEX_THREAD_ID', 'TRAEX_ADAPTIVE_FALLBACK_EXECUTOR',
  'TRAEX_ADAPTIVE_FALLBACK_MODEL', 'TRAEX_ADAPTIVE_FALLBACK_EFFORT']) delete env[key];
if (fallback) Object.assign(env, { TRAEX_ADAPTIVE_FALLBACK_EXECUTOR: 'codex-app',
  TRAEX_ADAPTIVE_FALLBACK_MODEL: 'gpt-6.1-sol', TRAEX_ADAPTIVE_FALLBACK_EFFORT: 'xhigh' });
writeFileSync(join(dir, 'smoke-input.txt'), token + '\n', { mode: 0o600 });
const runner = spawn(process.execPath, [
  ...(source ? ['--import', 'tsx', join(repo, 'src/codex-app-runner.ts')] : [join(repo, 'dist/codex-app-runner.js')]),
  '--session-id', sessionId, '--cwd', dir, '--locale', 'zh',
], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', markerBuffer = '', errorTail = '';
const finals: any[] = [], notices: string[] = [];
let changed = () => {};
runner.stdout.on('data', chunk => {
  const text = String(chunk);
  output = (output + text).slice(-1024 * 1024);
  markerBuffer += text;
  const marker = /\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = marker.exec(markerBuffer))) {
    const payload = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8'));
    if (match[1] === 'final') finals.push(payload);
    if (match[1] === 'progress') {
      const text = String(payload.content ?? '');
      if (/排队|切换|准入|目录|探测/.test(text)) {
        notices.push(text);
        console.log(JSON.stringify({ event: 'notice', text: text.slice(-220) }));
      }
    }
    consumed = marker.lastIndex;
  }
  markerBuffer = markerBuffer.slice(consumed || Math.max(0, markerBuffer.length - 65536));
  changed();
});
runner.stderr.on('data', chunk => { errorTail = (errorTail + chunk).slice(-1200); changed(); });
runner.on('exit', () => changed());

/** 等待事件推动状态，不轮询目录或重复提交请求；超时留下本地证据目录。 */
function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changed = () => {}; reject(new Error('live_smoke_timeout')); }, timeoutMs);
    changed = () => {
      if (condition()) { clearTimeout(timer); changed = () => {}; resolve(); }
      else if (runner.exitCode !== null) { clearTimeout(timer); reject(new Error('live_runner_exited')); }
    };
    changed();
  });
}

const rounds: any[] = [];
try {
  console.log(JSON.stringify({ event: 'started', sessionId, evidenceDir: dir, fallback, source, pid: runner.pid }));
  await until(() => output.includes('Codex App connected.'), 30000);
  const prompts = [
    '这是隔离自测。请实际调用 shell 工具读取当前目录 smoke-input.txt，仅回复文件中的完整标记。不修改任何文件、不访问网络、不发送飞书消息。',
    '继续隔离自测。不要再读文件，回复上一轮读到的完整标记并在末尾追加 :2。只输出结果，不发送飞书消息。',
    '最后一轮隔离自测。不要调用工具，回复最初读到的完整标记并在末尾追加 :3。只输出结果，不发送飞书消息。',
  ];
  for (let i = 0; i < prompts.length; i++) {
    const started = Date.now();
    runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'message', content: prompts[i] })).toString('base64') + '\n');
    await until(() => finals.length > i, 150000);
    const state = sessionModelStatus(dir, sessionId);
    const expected = token + (i ? `:${i + 1}` : '');
    if (state.runtime?.phase !== 'completed' || !String(finals[i].content).includes(expected)) {
      throw new Error(`live_round_${i + 1}_failed: ${String(finals[i].content).slice(-600)}`);
    }
    rounds.push({ round: i + 1, elapsedMs: Date.now() - started, executor: state.runtime.selection?.executor,
      model: state.runtime.selection?.model, effort: state.runtime.selection?.effort, threadId: state.runtime.threadId,
      turnId: state.runtime.turnId, phase: state.runtime.phase, answerVerified: true });
    console.log(JSON.stringify({ event: 'round_completed', ...rounds.at(-1) }));
  }
  if (!/\n\$ .*smoke-input\.txt/.test(output)) throw new Error('real_tool_execution_not_observed');
  if (expectedExecutor && rounds.some(round => round.executor !== expectedExecutor)) throw new Error('expected_executor_not_observed');
  const report = { ok: true, sessionId, source, fallback, evidenceDir: dir, rounds, toolExecutionVerified: true,
    notices, checkedAt: new Date().toISOString() };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'complete', ...report }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, sessionId, evidenceDir: dir, rounds,
    error: String(error), stderr: errorTail }));
  process.exitCode = 1;
} finally { runner.kill('SIGTERM'); }
