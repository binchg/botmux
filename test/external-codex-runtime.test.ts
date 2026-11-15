import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExternalCodexTurn, buildExternalCodexForwardCard, buildExternalCodexStatusCard } from '../src/services/external-codex-runtime.js';

it('renders the three native-session lines and two read-only links immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'external-codex-status-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, [
    { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'native-status' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra', service_tier: 'default' } } },
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'ultra' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  vi.stubEnv('SESSION_DATA_DIR', dir);
  vi.stubEnv('BOTMUX_HISTORY_BASE_URL', 'http://100.64.0.1:7891');
  try {
    const card = JSON.parse(buildExternalCodexStatusCard({ threadId: 'native-status', rolloutPath, cwd: '/lxy', chatId: 'chat', larkAppId: 'app', ownerOpenId: 'owner', rootMessageId: 'root' }));
    expect(card.body.elements[0].tag).toBe('markdown');
    expect(card.body.elements[0].content).toContain('6-astra U F×');
    const actions = card.body.elements.slice(1);
    expect(actions.map((action: any) => action.text.content)).toEqual(['🖥️ 打开 Web 终端（只读）', '🔗 对话历史']);
    expect(actions[0].multi_url.url).toContain('view=terminal');
    expect(actions[1].multi_url.url).not.toContain('view=terminal');
  } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});

it('submits a Lark follow-up to the exact fork in the default library and waits for completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'external-codex-rpc-'));
  const binary = join(dir, 'mock-codex.cjs');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', l => {
 const m=JSON.parse(l); fs.appendFileSync('requests.jsonl', JSON.stringify({m,home:process.env.CODEX_HOME})+'\\n');
 if(!m.id)return;
 const result=m.method==='turn/start'?{turn:{id:'turn'}}:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 if(m.method==='turn/start')setTimeout(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'fork',turn:{id:'turn',status:'completed'}}})+'\\n'),20);
});
`, { mode: 0o700 });
  try {
    let checkpoints = 0;
    await runExternalCodexTurn(binary, '/default-codex', {
      threadId: 'fork', rolloutPath: '', cwd: dir, larkAppId: 'app', chatId: 'chat', ownerOpenId: 'owner', rootMessageId: 'root',
    }, 'follow-up', () => { checkpoints++; }, 'stable-client-receipt');
    const rows = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(checkpoints).toBe(1);
    expect(rows.find(r => r.m.method === 'turn/start').m.params.clientUserMessageId).toBe('stable-client-receipt');
    expect(rows.every(r => r.home === '/default-codex')).toBe(true);
    expect(rows.find(r => r.m.method === 'thread/resume').m.params.threadId).toBe('fork');
    expect(rows.find(r => r.m.method === 'turn/start').m.params.input).toEqual([{ type: 'text', text: 'follow-up' }]);
    expect(rows.some(r => r.m.method === 'thread/fork')).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('titles replies with the current question and omits bridge metadata and statistics', () => {
  const text = 'VS Code 原始结果\n第二行保留';
  const card = buildExternalCodexForwardCard({ threadId: 'main-session-123', rolloutPath: '', cwd: '/repo', chatId: 'chat', larkAppId: 'app', ownerOpenId: 'owner', rootMessageId: 'root', firstUserMessage: '旧问题', currentUserMessage: '第二次追问测试' }, text, 'final');
  const parsed = JSON.parse(card);
  expect(parsed.header.title.content).toBe('第二次追问测试');
  expect(card).toContain('VS Code 原始结果'); expect(card).toContain('第二行保留');
  for (const redundant of ['原会话转发', '追问原文', 'main-ses', 'botmux', 'Token', '累计运行', '/repo', '旧问题']) expect(card).not.toContain(redundant);
  expect(parsed.body.elements.map((e: any) => e.tag)).toEqual(['markdown']);
});

it('shows a question once and uses its original text for progress titles', () => {
  const binding = { threadId: 't', rolloutPath: '', cwd: '/repo', chatId: 'c', larkAppId: 'a', ownerOpenId: 'o', rootMessageId: 'r', currentUserMessage: '第二次追问测试' };
  const user = JSON.parse(buildExternalCodexForwardCard(binding, binding.currentUserMessage, 'user'));
  expect(user.header).toBeUndefined();
  expect(user.body.elements).toHaveLength(1);
  expect(user.body.elements[0].content).toContain('第二次追问测试');
  const progress = JSON.parse(buildExternalCodexForwardCard(binding, '检查通过。', 'progress'));
  expect(progress.header.title.content).toBe('第二次追问测试');
  expect(progress.body.elements).toHaveLength(1);
  expect(progress.body.elements[0].content).toContain('检查通过。');
});
