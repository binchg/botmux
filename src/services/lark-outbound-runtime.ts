/** 每个 daemon 为所属机器人安装独立回复队列，重试使用 SDK 实时获取的凭据。 */
import { join } from 'node:path';
import { getBotClient, loadBotConfigs } from '../bot-registry.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { installLarkOutboundPrivacy } from '../im/lark/outbound-privacy.js';
import { LarkReplyOutbox } from './lark-reply-outbox.js';
import { protectLarkClientDelivery } from './lark-client-delivery.js';
import { assertSessionReplyAllowed } from './session-reply-policy.js';
import { registerSessionHandoffApi } from '../core/session-handoff-api.js';

/** 在注册机器人前准备队列；首次后台补发晚于同步注册，不阻塞 daemon 启动。 */
export function startLarkOutboundDelivery(botIndex: number): { outbox: LarkReplyOutbox; protectClient: () => void } | undefined {
  const bot = loadBotConfigs()[botIndex];
  if (!bot) throw new Error('Reply outbox requires the assigned bot configuration');
  registerSessionHandoffApi(bot.larkAppId);
  const deliveryGuard = (request: import('./lark-reply-outbox.js').OutboundRequest) =>
    assertSessionReplyAllowed(request, bot.larkAppId);
  let outbox: LarkReplyOutbox;
  try {
    outbox = new LarkReplyOutbox(join(config.session.dataDir, 'reply-outbox', bot.larkAppId),
      request => getBotClient(bot.larkAppId).request(request as any), Date.now, message => logger.info(message));
  } catch {
    // 持久目录故障只降低补发能力，不阻止后台任务和即时回复启动。
    installLarkOutboundPrivacy(undefined, undefined, deliveryGuard);
    logger.error('Reply outbox unavailable; redacted immediate delivery remains enabled');
    return undefined;
  }
  installLarkOutboundPrivacy(undefined, outbox, deliveryGuard);
  outbox.start();
  logger.info(`Reply outbox restored ${JSON.stringify(outbox.status())}`);
  return { outbox, protectClient: () => protectLarkClientDelivery(getBotClient(bot.larkAppId), outbox, bot.larkAppId) };
}
