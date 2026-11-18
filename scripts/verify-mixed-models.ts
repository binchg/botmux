/** 隔离调用正式运行器，测首个可见输出、答题、真实工具、追问和独立代码判分；不向飞书发消息。 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionModelStatus, writeSessionModel } from '../src/services/session-model-store.js';

const argv = process.argv.slice(2);
if (!argv.includes('--allow-model')) throw new Error('真实模型调用需显式 --allow-model');
const value = (key: string) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : undefined;
const executor = value('--executor') ?? 'codex-app', model = value('--model');
const mixed = argv.includes('--mixed'), source = argv.includes('--source');
if (!['codex-app', 'traex', 'ark'].includes(executor) || (!mixed && !model)) throw new Error('--executor / --model required');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'botmux-model-check-')), sessionId = `model-check-${randomUUID()}`;
const marker = `MODEL_CHECK_${randomUUID()}`;
writeFileSync(join(dir, 'smoke-input.txt'), marker + '\n', { mode: 0o600 });
const env: NodeJS.ProcessEnv = { ...process.env, SESSION_DATA_DIR: dir, BOTMUX_MODEL_METRICS: '1' };
for (const key of ['BOTMUX_SESSION_ID', 'CODEX_THREAD_ID', 'BOTMUX_IM_IPC_PORT', 'BOT_SHARED_CONTEXT_GROUP',
  'BOT_SHARED_MEMORY_DIR', 'TRAEX_ADAPTIVE_MODELS', 'TRAEX_APP_SERVER_DEFAULT', 'TRAEX_ADAPTIVE_FALLBACK_EXECUTOR']) delete env[key];
if (!mixed) {
  delete env.MIXED_MODEL_ROUTES_FILE;
  writeSessionModel(dir, sessionId, { executor: executor as 'codex-app' | 'traex' | 'ark', model: model!,
    effort: value('--effort') ?? 'xhigh', serviceTier: 'default', routingMode: 'fixed', hookTrust: 'always' });
}
const runner = spawn(process.execPath, [
  ...(source ? ['--import', 'tsx', join(repo, 'src/codex-app-runner.ts')] : [join(repo, 'dist/codex-app-runner.js')]),
  '--session-id', sessionId, '--cwd', dir, '--locale', 'zh',
  ...(value('--codex-bin') ? ['--codex-bin', value('--codex-bin')!] : []),
], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', buffer = '', stderr = '', changed = () => {}, started = 0, firstVisibleMs: number | undefined;
const finals: any[] = [], notices: string[] = [], rounds: any[] = [];
runner.stdout.on('data', chunk => {
  const text = String(chunk); output = (output + text).slice(-1024 * 1024); buffer += text;
  const pattern = /\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g;
  let match: RegExpExecArray | null, end = 0;
  while ((match = pattern.exec(buffer))) {
    const item = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8'));
    if (match[1] === 'final') finals.push(item);
    if (match[1] === 'model_metrics' && started && firstVisibleMs === undefined) firstVisibleMs = item.firstTokenAtMs - started;
    if (match[1] === 'progress' && /排队|降级|选择|准入|429/.test(item.content ?? '')) notices.push(item.content);
    end = pattern.lastIndex;
  }
  buffer = buffer.slice(end || Math.max(0, buffer.length - 65536)); changed();
});
runner.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); changed(); });
runner.on('exit', () => changed());

/** 输出事件驱动等待；长队列作为独立结果返回，不等待整个远端队列清空。 */
function until(test: () => boolean, timeoutMs: number, detectQueue = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changed = () => {}; reject(new Error('model_check_timeout')); }, timeoutMs);
    changed = () => {
      const runtime = sessionModelStatus(dir, sessionId).runtime;
      const longQueue = detectQueue && !mixed && runtime?.routing?.state === 'queued'
        && (runtime.routing.position === undefined || runtime.routing.position > 10);
      if (test()) { clearTimeout(timer); changed = () => {}; resolve(); }
      else if (longQueue || runner.exitCode !== null) {
        clearTimeout(timer); changed = () => {}; reject(new Error(longQueue ? 'provider_queue_observed' : 'model_runner_exited'));
      }
    }; changed();
  });
}
/** 去除常见代码围栏，只对最终答案和独立执行结果判分。 */
function jsonAnswer(text: string): any { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
const prompts = [
  '隔离测速。不要调用工具，不解释。只输出一个 JSON 数组，元素依次为整数 1 到 60。不要发送飞书消息。',
  '独立答题。任务 A/B/C/D/E 的工时分别是3/4/2/5/1；C依赖A，D依赖A和B，E依赖C和D。两台相同处理器，任务不可抢占。求最短总工期与关键路径，只输出JSON {"makespan":整数,"critical_path":[任务名]}，不调用工具、不发送消息。',
  '隔离工具验证：请实际调用 shell 读取当前目录 smoke-input.txt，只回复其中的完整标记；不访问网络、不发送飞书消息。',
  '继续上一轮，不调用工具，回复上一轮读到的完整标记并在末尾追加 :followup。不要发送飞书消息。',
  '仅在当前隔离目录创建 answer.mjs，具名导出函数 mergeIntervals(intervals)：合并重叠或共享端点的闭区间，按起点升序，不修改输入。空输入返回空数组，任何起点大于终点时抛 RangeError。请调用工具实际写文件，完成后只回复 DONE。不访问网络、不发送消息，不修改其它文件。',
];
let terminal = 'completed', failure: string | undefined;
try {
  console.log(JSON.stringify({ event: 'started', dir, sessionId, executor, model, mixed, source }));
  await until(() => output.includes('Codex App connected.'), 30000);
  for (let index = 0; index < prompts.length; index++) {
    started = Date.now(); firstVisibleMs = undefined;
    runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'message', content: prompts[index] })).toString('base64') + '\n');
    await until(() => finals.length > index, 150000, true);
    const elapsedMs = Date.now() - started, answer = String(finals[index].content ?? '');
    const state = sessionModelStatus(dir, sessionId);
    let passed = state.runtime?.phase === 'completed';
    if (passed && index === 0) passed = JSON.stringify(jsonAnswer(answer)) === JSON.stringify(Array.from({ length: 60 }, (_, i) => i + 1));
    if (passed && index === 1) { const result = jsonAnswer(answer); passed = result.makespan === 10 && JSON.stringify(result.critical_path) === '["B","D","E"]'; }
    if (passed && index === 2) passed = answer.trim() === marker && /\n\$ .*smoke-input\.txt/.test(output);
    if (passed && index === 3) passed = answer.trim() === marker + ':followup';
    if (passed && index === 4) {
      const judge = `import assert from 'node:assert/strict'; import {mergeIntervals as f} from ${JSON.stringify('file://' + join(dir, 'answer.mjs'))};
        assert.deepEqual(f([]),[]); assert.deepEqual(f([[1,4],[4,5]]),[[1,5]]);
        assert.deepEqual(f([[8,9],[1,3],[2,7]]),[[1,7],[8,9]]); assert.deepEqual(f([[-3,-1],[-2,0]]),[[-3,0]]);
        const x=[[5,6],[1,2]],before=JSON.stringify(x);f(x);assert.equal(JSON.stringify(x),before);
        assert.throws(()=>f([[3,1]]),RangeError);console.log('6/6');`;
      passed = execFileSync(process.execPath, ['--input-type=module', '-e', judge], { timeout: 5000, encoding: 'utf8' }).trim() === '6/6';
    }
    rounds.push({ round: index + 1, test: ['speed', 'reasoning', 'tool', 'followup', 'coding'][index], passed,
      elapsedMs, firstVisibleMs, firstVisibleMetric: 'first_assistant_delta_including_routing_and_queue',
      selection: state.runtime?.selection, threadId: state.runtime?.threadId, turnId: state.runtime?.turnId,
      requestedModelVerified: !!state.runtime?.selection, backendIdentityVerified: false });
    console.log(JSON.stringify({ event: 'round', ...rounds.at(-1) }));
    started = 0;
    if (!passed) { terminal = 'failed'; break; }
  }
} catch (error) {
  failure = String(error); terminal = failure.includes('provider_queue_observed') ? 'provider_queue' : 'failed';
} finally {
  const report = { ok: terminal === 'completed' && rounds.length === prompts.length && rounds.every(row => row.passed),
    terminal, failure, executor, model, mixed, source, dir, rounds, notices,
    queue: sessionModelStatus(dir, sessionId).runtime?.routing ?? null, checkedAt: new Date().toISOString() };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, 'runner.stderr'), stderr, { mode: 0o600 });
  console.log(JSON.stringify({ event: 'complete', ...report }));
  runner.stdin.write('::botmux-codex-app:' + Buffer.from(JSON.stringify({ type: 'interrupt' })).toString('base64') + '\n');
  runner.kill('SIGTERM');
  if (!report.ok) process.exitCode = 1;
}
