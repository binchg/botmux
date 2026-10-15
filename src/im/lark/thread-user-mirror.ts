/** 普通群用户话题消息补发：回读平台关联身份，已经同步的消息绝不再次转发。 */
import { createHash } from 'node:crypto';
import type { ThreadMessage } from './thread-sync.js';

export interface MirrorSource extends ThreadMessage {
  sender?: { id?: string; id_type?: string; sender_type?: string };
  deleted?: boolean;
}

/** 仅处理已获授权、归属已知会话的人类话题追加消息。 */
export interface MirrorInput {
  enabled: boolean;
  ownsSession: boolean;
  senderType: string;
  senderOpenId: string;
  message: ThreadMessage;
}

/** 平台调用与持久去重均可独立验证；发送端用已核验原消息保留正文和附件。 */
export interface MirrorPort {
  chatMode(chatId: string): Promise<string>;
  read(id: string): Promise<MirrorSource | undefined>;
  claim(key: string, source: MirrorSource): boolean;
  forward(id: string, chatId: string, uuid: string, source: MirrorSource): Promise<string>;
  record(key: string, status: 'sent' | 'failed', mirrorId?: string): void;
}

/** 先验身份再认领；认领落盘失败时不发送，发送结果不明时也不清除认领重发。 */
export async function mirrorThreadUserMessage(input: MirrorInput, port: MirrorPort): Promise<string> {
  const message = input.message;
  if (!input.enabled || !input.ownsSession || input.senderType !== 'user'
      || message.chat_type !== 'group' || !message.chat_id || !message.root_id || !message.thread_id
      || message.root_id === message.message_id || message.sync_to_chat_info?.type) return 'ineligible';
  if (await port.chatMode(message.chat_id) !== 'group') return 'not-regular-group';
  const source = await port.read(message.message_id);
  if (!source || source.deleted || source.message_id !== message.message_id
      || source.chat_id !== message.chat_id || source.root_id !== message.root_id
      || source.thread_id !== message.thread_id || source.sender?.sender_type !== 'user'
      || source.sender.id_type !== 'open_id' || source.sender.id !== input.senderOpenId) return 'unverified';
  // 手动勾选后，原消息与群副本任意到达顺序都以平台关联信息为准。
  if (source.sync_to_chat_info?.type || source.sync_to_chat_info?.related_message_id) return 'already-synced';
  const key = createHash('sha256').update(`${source.chat_id}:${source.message_id}`).digest('hex');
  if (!port.claim(key, source)) return 'duplicate';
  try {
    const mirrorId = await port.forward(source.message_id, message.chat_id, key.slice(0, 32), source);
    port.record(key, 'sent', mirrorId);
    return 'sent';
  } catch (error) {
    port.record(key, 'failed');
    throw error;
  }
}
