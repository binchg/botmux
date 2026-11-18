#!/usr/bin/env node
/** 隔离测试用三通道 app-server，按真实协议发出排队、限流与工具完成事件。 */
const fs = require('node:fs');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const name = process.env.CODEX_HOME?.endsWith('/ark-home') ? 'ark'
  : process.argv[1].endsWith('/traex') ? 'traex' : 'codex-app';
const threadId = name + '-thread';
const history = [];
let count = 0;
if (process.argv[2] === 'debug') {
  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list', model_provider_id: 'trae',
    supported_reasoning_levels: [{ effort: 'xhigh' }], business_metadata: { load: { load_percent: 30 } } }] }));
  process.exit(0);
}
const db = new DatabaseSync(process.env.TRAE_HOME + '/cli/logs_2.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)');
/** 输出一条完整 JSON-RPC 消息。 */
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
/** 完成当前测试轮次，错误仅来自调用方指定的测试场景。 */
function complete(id, status, error) {
  send({ method: 'turn/completed', params: { threadId, turn: { id, status, ...(error ? { error: { message: error } } : {}) } } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  fs.appendFileSync(process.env.MIXED_TEST_CALLS, JSON.stringify({ name, method: message.method,
    params: message.params, home: process.env.CODEX_HOME }) + '\n');
  let result = {};
  if (message.method === 'config/read') result = { config: { model: name === 'ark' ? 'ep-real' : 'gpt-6.1-sol', model_reasoning_effort: 'xhigh' } };
  if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: threadId }, model: message.params.model };
  if (message.method === 'thread/read') result = { thread: { turns: [{ items: history }] } };
  if (message.method === 'turn/start') {
    const id = 'turn-' + (++count);
    history.push({ type: 'userMessage', content: message.params.input });
    send({ id: message.id, result: { turn: { id } } });
    setTimeout(() => {
      if (name === 'traex') {
        const now = Date.now();
        db.prepare('INSERT INTO logs(ts,ts_nanos,thread_id,process_uuid,feedback_log_body) VALUES(?,?,?,?,?)')
          .run(Math.floor(now / 1000), (now % 1000) * 1e6, threadId, 'pid:' + process.pid + ':test', 'request_wait_in_queue Your queue position is 800');
        send({ method: 'hook/completed', params: { threadId, turnId: id, run: {} } });
      } else if (name === 'ark') complete(id, 'failed', 'HTTP 429 rate limit exceeded');
      else {
        send({ method: 'item/started', params: { threadId, item: { id: 'read', type: 'commandExecution', command: 'cat smoke-input.txt' } } });
        send({ method: 'item/completed', params: { threadId, item: { id: 'read', type: 'commandExecution', command: 'cat smoke-input.txt', exitCode: 0 } } });
        send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'answer', text: 'MIXED_OK', phase: 'final_answer' } } });
        complete(id, 'completed');
      }
    }, 50);
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} }); complete('turn-' + count, 'interrupted'); return;
  }
  send({ id: message.id, result });
});
