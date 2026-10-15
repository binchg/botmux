/** 用户授权的普通群补发入口；按机器人、群和用户启用，默认不复制任何消息。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBotClient } from '../../bot-registry.js';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { logger } from '../../utils/logger.js';
import { getChatModeStrict, getMessageDetail } from './client.js';
import { mirrorThreadUserMessage, type MirrorSource } from './thread-user-mirror.js';
import type { ThreadMessage } from './thread-sync.js';
import { resolveSender } from './identity-cache.js';
import { attributedMirrorContent } from './thread-user-mirror-content.js';

interface MirrorTarget { appId: string; chatId: string; userOpenId: string }

/** 授权只从本地配置读取，用户正文和飞书事件不能开启跨位置投递。 */
function isEnabled(appId: string, chatId: string | undefined, userOpenId: string): boolean {
  const path = join(config.session.dataDir, 'user-thread-mirror-settings.json');
  if (!existsSync(path)) return false;
  const settings = JSON.parse(readFileSync(path, 'utf8')) as { targets?: MirrorTarget[] };
  return Array.isArray(settings.targets) && settings.targets.some(target =>
    target.appId === appId && (target.chatId === chatId || target.chatId === '*') && target.userOpenId === userOpenId);
}

/** 创建文件的排他语义覆盖多机器人进程与重启；收据不保存正文或附件内容。 */
function claimMirror(directory: string, key: string, source: MirrorSource): boolean {
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, `${key}.json`), JSON.stringify({ status: 'pending',
      sourceId: source.message_id, chatId: source.chat_id, createdAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

/** 在入站权限与会话归属检查通过后异步执行，不阻塞消息注入或改变回复话题。 */
export async function maybeMirrorThreadUserMessage(
  appId: string, message: ThreadMessage, senderType: string, senderOpenId: string, ownsSession: boolean,
): Promise<void> {
  try {
    const enabled = isEnabled(appId, message.chat_id, senderOpenId);
    if (!enabled) return;
    const directory = join(config.session.dataDir, 'user-thread-mirror-receipts');
    const status = await mirrorThreadUserMessage({ enabled, ownsSession, senderType, senderOpenId, message }, {
      chatMode: chatId => getChatModeStrict(appId, chatId),
      read: async id => (await getMessageDetail(appId, id, { userCardContent: false })).items
        ?.find((item: MirrorSource) => item.message_id === id),
      claim: (key, source) => claimMirror(directory, key, source),
      forward: async (id, chatId, uuid, source) => {
        const sender = await resolveSender(appId, senderOpenId, 'user');
        const content = attributedMirrorContent(source, sender?.name || `用户（${senderOpenId}）`);
        const client = getBotClient(appId).im.v1.message;
        // 文本与图文一次发送即带姓名；其它附件用原生聊天记录保留发送者和资源。
        const result = content
          ? await client.create({ params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, uuid, ...content } })
          : await client.mergeForward({ params: { receive_id_type: 'chat_id', uuid },
            data: { receive_id: chatId, message_id_list: [id] } });
        const sent = result.data && ('message_id' in result.data ? result.data
          : 'message' in result.data ? result.data.message : undefined);
        if (result.code !== 0 || !sent?.message_id || sent.chat_id !== chatId) {
          throw new Error(`用户消息转发未获有效回执：${result.code ?? 'missing-code'}`);
        }
        return sent.message_id;
      },
      record: (key, state, mirrorId) => {
        const path = join(directory, `${key}.json`);
        const receipt = JSON.parse(readFileSync(path, 'utf8'));
        atomicWriteFileSync(path, JSON.stringify({ ...receipt, status: state, mirrorId, updatedAt: new Date().toISOString() }));
      },
    });
    logger.info(`[thread-user-mirror] app=${appId} source=${message.message_id} status=${status}`);
  } catch (error) {
    logger.warn(`[thread-user-mirror] source=${message.message_id} 补发失败，原消息继续处理：${String(error)}`);
  }
}
