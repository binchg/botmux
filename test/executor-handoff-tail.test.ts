/** 验证大线程接续只取可见尾部，切换不等待旧进程序列化整份历史。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { rolloutHandoff } from '../src/services/executor-handoff-tail.js';
import { parseSessionModelIntent } from '../src/services/session-model-intent.js';

it('从超过读取窗口的 TraeX mutation 和 Codex 记录取可见正文，排除工具与分析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-tail-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    const item = (id: string, role: string, text: string, phase?: string) => ({
      id, type: 'message', role, phase, content: [{ type: 'text', text }],
    });
    const response = item('a', 'assistant', '最近答案', 'final_answer');
    const records = [
      { type: 'history_mutation', payload: { items: [item('u', 'user', '原生续接问题')] } },
      { type: 'response_item', payload: response },
      { type: 'history_mutation', payload: { items: [response, item('h', 'assistant', '不可见分析', 'analysis'),
        { type: 'function_call_output', output: '不可见工具结果' }] } },
    ];
    writeFileSync(path, JSON.stringify({ padding: '旧历史'.repeat(1000000) }) + '\n'
      + records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const handoff = rolloutHandoff(path);
    expect(handoff).toContain('原生续接问题');
    expect(handoff?.match(/最近答案/g)).toHaveLength(1);
    expect(handoff).not.toMatch(/不可见|旧历史/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('识别中文中档及英文 no fast，不误开启快档', () => {
  expect(parseSessionModelIntent('本会话 改成 gpt 6.2 sol 中 no fast')).toMatchObject({
    model: 'gpt 6.2 sol', effort: 'medium', serviceTier: 'default', routingMode: 'fixed',
  });
});
