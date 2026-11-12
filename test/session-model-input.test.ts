import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionModelInput } from '../src/services/session-model-input.js';
import { readSessionModel } from '../src/services/session-model-store.js';

/** 能力查询延迟时保持消息顺序，失败和取消不能偷偷使用旧模型执行。 */
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const catalog = [{ model: 'gpt-6.1-sol', defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }], serviceTiers: [{ id: 'priority' }] }];
it.each(['success', 'cancel', 'unsupported'])('目录等待后的输入处理：%s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'model-input-')); roots.push(root);
  let resolve!: (value: typeof catalog) => void;
  const models = new Promise<typeof catalog>(done => { resolve = done; });
  const deliver = vi.fn(), notice = vi.fn();
  const input = new SessionModelInput({ dataDir: root, sessionId: 's', models: async () => models,
    defaults: () => ({ executor: 'codex-app', model: 'old', effort: 'high', serviceTier: 'priority' }), deliver, notice });
  const command = mode === 'unsupported' ? '用 gpt9.9 xhigh' : '本会话切换成 gpt 6.1 xhigh 不是 fast';
  input.receive(command); input.receive('后续业务请求');
  await Promise.resolve(); expect(deliver).not.toHaveBeenCalled();
  if (mode === 'cancel') input.cancel();
  resolve(catalog);
  if (mode === 'success') {
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls.map(call => call[0])).toEqual([command, '后续业务请求']);
    expect(readSessionModel(root, 's')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', serviceTier: 'default', routingMode: 'fixed' });
  } else if (mode === 'unsupported') {
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringContaining('不支持模型'), true));
    expect(deliver).toHaveBeenCalledWith('后续业务请求', false);
    expect(readSessionModel(root, 's')).toBeUndefined();
  } else {
    input.receive('取消后新请求');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver).toHaveBeenCalledWith('取消后新请求', false);
    expect(readSessionModel(root, 's')).toBeUndefined();
  }
});
