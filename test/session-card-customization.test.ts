/** 定制只作用于会话卡：保留终端、历史与正文，不能移除审批和提问操作。 */
import { expect, it } from 'vitest';
import { customizeSessionCard } from '../src/services/session-card-customization.js';
import { buildTitledMarkdownCard } from '../src/im/lark/md-card.js';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { installLarkOutboundPrivacy } from '../src/im/lark/outbound-privacy.js';

const prefs = { compactButtons: true, modelInCard: true };
const button = (action: string) => ({ tag: 'button', value: { action }, text: { content: action } });
const link = (url: string) => ({ tag: 'button', multi_url: { url } });

it('只留下 HTTP 终端和历史入口，过滤管理按钮和本地 CLI 入口', () => {
  const card = { header: {}, elements: [{ tag: 'div', text: { content: '📁 /workspace · 模型' } },
    { tag: 'action', actions: [button('toggle_display'), button('session_model_open'),
      link('https://terminal/s/id'), link('https://history/h/id'), link('botmux://terminal'), button('get_write_link'), button('close')] }] };
  const result = JSON.parse(customizeSessionCard(JSON.stringify(card), prefs));
  expect(result.elements[1].actions).toEqual([link('https://terminal/s/id'), link('https://history/h/id')]);
  expect(result.elements[0]).toEqual(card.elements[0]);
  expect(customizeSessionCard(JSON.stringify(card), {})).toBe(JSON.stringify(card));
});

it('同时开启精简和折叠时，仅收起终端和历史入口并保留原链接', () => {
  const terminal = link('https://terminal/s/id');
  const history = link('https://history/conversation/id');
  const actions = [button('toggle_display'), terminal, button('session_model_open'), history, button('close'),
    button('get_write_link'), link('botmux://terminal')];
  const summary = { tag: 'div', text: { content: '📁 WT1 · 6.2-sol XH F√' } };
  const card = JSON.stringify({ header: {}, elements: [summary,
    { tag: 'action', actions: actions.slice(0, 3) }, { tag: 'action', actions: actions.slice(3) }] });
  const collapse = { ...prefs, collapseActions: true };
  const content = customizeSessionCard(card, collapse);
  const result = JSON.parse(content);
  expect(result.elements).toHaveLength(2);
  expect(result.elements[0]).toEqual(summary);
  expect(result.elements[1]).toMatchObject({ tag: 'collapsible_panel', expanded: false, header: { title: { content: '更多操作' } } });
  expect(result.elements[1].elements.flatMap((row: any) => row.columns.flatMap((column: any) => column.elements))).toEqual([terminal, history]);
  expect(customizeSessionCard(content, collapse)).toBe(content);
});

it('移除实际出站回复的模型引用首行，正文、内部引用与普通机器人保持原样', () => {
  const card = buildTitledMarkdownCard({ title: '任务', brand: '',
    md: '> **TraeX · GPT-6.1-Sol · xhigh · 负载 109%**\n\n已发送请求。' });
  const result = JSON.parse(customizeSessionCard(card, prefs));
  expect(result.body.elements[0].content).toBe('已发送请求。');
  const plain = JSON.stringify({ text: '> **TraeX · GPT-6.1-Sol · xhigh**\n\n答复' });
  expect(JSON.parse(customizeSessionCard(plain, prefs)).text).toBe('答复');
  expect(customizeSessionCard(card, {})).toBe(card);
});

it('保留提问、审批与模型选择面板，不因存在链接就删掉操作', () => {
  const card = JSON.stringify({ elements: [{ tag: 'action', actions: [button('approve'), button('reject'), link('https://docs/')] }] });
  expect(JSON.parse(customizeSessionCard(card, prefs))).toEqual(JSON.parse(card));
  expect(customizeSessionCard('not-json', prefs)).toBe('not-json');
});

it('真实 SDK 发送边界应用定制，后续隐私脱敏仍然生效', async () => {
  const http = defaultHttpInstance.create();
  installLarkOutboundPrivacy(http, undefined, undefined, content => customizeSessionCard(content, prefs));
  let sent: any;
  await http.request({ method: 'POST', url: 'https://open.feishu.cn/open-apis/im/v1/messages/root/reply',
    data: { msg_type: 'interactive', content: buildTitledMarkdownCard({ title: '任务', brand: '',
      md: '> **TraeX · GPT-6.1-Sol · xhigh**\n\n答复 test.person@example.invalid' }) },
    adapter: async request => {
      sent = JSON.parse(request.data).content;
      return { data: { code: 0 }, status: 200, statusText: 'OK', headers: {}, config: request };
    } });
  expect(sent).not.toContain('TraeX ·');
  expect(sent).toContain('答复');
  expect(sent).not.toContain('test.person');
});
