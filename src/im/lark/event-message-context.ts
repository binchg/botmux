/** 归一后的平台消息上下文；由 event-dispatcher.ts 拆分，来源 c397c9af。 */
import { EventHandlers } from './event-types.js';

export interface IncomingMessageContext {
  data: any; larkAppId: string; handlers: EventHandlers; message: any; sender: any;
  chatId: string; chatType: 'group' | 'p2p'; messageId: string;
}
