/** 飞书“同时发送到群”的群副本与话题原消息归一，避免重复任务和错误回复目标。 */
export interface ThreadMessage {
  message_id: string;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_type?: string;
  sync_to_chat_info?: { type?: number; related_message_id?: string; thread_id?: string };
  [key: string]: any;
}

type ReadMessage = (id: string) => Promise<{ items?: Array<Partial<ThreadMessage>> }>;

/** 不改正文或发送者，只使用平台回读的关联身份；群副本缺失时仍可用原消息 ID 回复。 */
export async function canonicalThreadMessage(message: ThreadMessage, read: ReadMessage): Promise<ThreadMessage> {
  let detail: Partial<ThreadMessage> = message;
  if (!message.sync_to_chat_info) {
    try {
      detail = (await read(message.message_id)).items?.find(item => item.message_id === message.message_id) ?? message;
    } catch { return message; }
  }
  const sync = detail.sync_to_chat_info;
  if (sync?.type !== 1 || !sync.related_message_id) {
    return sync ? { ...message, ...routingFields(detail), sync_to_chat_info: sync } : message;
  }
  let source: Partial<ThreadMessage> | undefined;
  try { source = (await read(sync.related_message_id)).items?.find(item => item.message_id === sync.related_message_id); }
  catch { /* 仍以官方关联的原消息 ID 为锚点，不能在群副本上再建话题。 */ }
  if (source && source.chat_id !== detail.chat_id) throw new Error('Thread sync message belongs to a different chat');
  if (source?.sync_to_chat_info?.related_message_id
      && source.sync_to_chat_info.related_message_id !== message.message_id) throw new Error('Thread sync relation is inconsistent');
  return { ...message, message_id: sync.related_message_id,
    root_id: source?.root_id ?? sync.related_message_id,
    parent_id: source?.parent_id, thread_id: source?.thread_id ?? sync.thread_id,
    sync_to_chat_info: { type: 2, related_message_id: message.message_id } };
}

function routingFields(message: Partial<ThreadMessage>): Partial<ThreadMessage> {
  return { root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id };
}

/** 两条不同 message_id 的推送使用同一个持久去重键，重复正文不能作为去重依据。 */
export function syncedMessageKey(message: ThreadMessage): string | undefined {
  return message.sync_to_chat_info?.type === 2 ? `thread-sync:${message.message_id}` : undefined;
}

/** 即时发送与持久补发共用修复，保留原 UUID 及正文。 */
export async function repairThreadReply(request: { url?: string; data?: any }, read: ReadMessage): Promise<void> {
  if (!request.data?.reply_in_thread) return;
  const match = request.url?.match(/\/im\/v1\/messages\/(om_[^/?]+)\/reply$/);
  if (!match) return;
  const message = await canonicalThreadMessage({ message_id: decodeURIComponent(match[1]) }, read);
  const target = message.root_id ?? message.message_id;
  if (target !== match[1]) request.url = request.url!.replace(match[1], encodeURIComponent(target));
}
