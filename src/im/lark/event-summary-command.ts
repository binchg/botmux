/** 总结命令匹配与会话范围选择；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { extractMessageTextForRouting, RoutingSource, classifySummaryChatKind } from './event-routing.js';
import { stripLeadingMentions } from './message-parser.js';
import { type SummaryCommandMatch } from './summary-command.js';
import { isBotMentioned } from './event-mentions.js';
import { summaryRangeFromBotConfig, DEFAULT_SUMMARY_PROMPT } from '../../services/summary-range-store.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';

export const SUMMARY_COMMAND_RE = /^\/summary(?:\s|$)/i;

export function summaryCommandText(message: any): string | undefined {
  const text = extractMessageTextForRouting(message);
  if (!text) return undefined;
  const stripped = stripLeadingMentions(text.trim(), message?.mentions ?? []).trim();
  return SUMMARY_COMMAND_RE.test(stripped) ? stripped : undefined;
}

export async function resolveSummaryCommandMatch(input: {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  routingSource: RoutingSource;
  message: any;
  senderOpenId: string | undefined;
}): Promise<SummaryCommandMatch | undefined> {
  if (input.chatType !== 'group') return undefined;
  if (!isBotMentioned(input.larkAppId, input.message, input.senderOpenId)) return undefined;
  const triggerText = summaryCommandText(input.message);
  if (!triggerText) return undefined;
  const chatKind = await classifySummaryChatKind(input);
  if (!chatKind) return undefined;
  return {
    chatKind,
    triggerText,
    range: summaryRangeFromBotConfig(getBot(input.larkAppId).config),
    prompt: DEFAULT_SUMMARY_PROMPT,
  };
}
