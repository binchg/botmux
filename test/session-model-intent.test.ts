import { expect, it } from 'vitest';
import { normalizeModelAlias, parseSessionModelIntent } from '../src/services/session-model-intent.js';
import { parseModelCommand } from '../src/cli/session-model-command.js';

/** 用户口语、反向速度要求和示例隔离，防止普通模型讨论改写会话。 */
it.each(['本会话切换成 gpt 6.1 xhigh 不是 fast。', '模型：gpt-6.1-sol xhigh，不要 fast',
  '<botmux_reminder>old</botmux_reminder><user_message>用 gpt6.1 xhigh，不是fast，继续分析故障</user_message>'])('识别明确指令：%s', text => {
  const intent = parseSessionModelIntent(text)!;
  expect(normalizeModelAlias(intent.model!)).toMatch(/gpt-?6\.1-?sol/);
  expect(intent).toMatchObject({ effort: 'xhigh', serviceTier: 'default', routingMode: 'fixed' });
});
it.each(['比较 gpt6.1 和 gpt5.5', 'gpt6.1 会不会更快', 'gpt6.1 好用吗', '用 gpt6.1 怎么样？', '不要切换成 gpt6.1 xhigh',
  '> 本会话切换成 gpt6.1 xhigh', '```\n本会话切换成 gpt6.1 xhigh\n```',
  '比如\n本会话切换成 gpt6.1 xhigh', '<user_message>继续排障</user_message>\n本会话切换成 gpt6.1 xhigh'])('讨论和引用不改变模型：%s', text => {
  expect(parseSessionModelIntent(text)).toBeUndefined();
});
it('速度和自动模式可独立修改', () => {
  expect(parseSessionModelIntent('本会话关闭 fast')).toEqual({ serviceTier: 'default' });
  expect(parseSessionModelIntent('恢复自动选模')).toEqual({ routingMode: 'adaptive' });
  expect(parseSessionModelIntent('用 gpt6.1 high fast')).toMatchObject({ effort: 'high', serviceTier: 'priority' });
  expect(parseModelCommand(['set', 'gpt-6.1-sol', 'xhigh', '--routing', 'adaptive']).body)
    .toMatchObject({ routingMode: 'adaptive' });
});
