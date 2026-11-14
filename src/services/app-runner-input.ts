import { writeLine } from './app-runner-protocol.js';

/** 终端输入分帧与 Botmux 控制消息解码，不保存会话或模型状态。 */
export class AppRunnerInput {
  private inputBuffer = '';
  constructor(private readonly handleUserMessage: (content: string) => void,
    private readonly interruptActiveTurn: () => Promise<void>) {}

private enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('::botmux-codex-app:')) {
    const encoded = trimmed.slice('::botmux-codex-app:'.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        this.handleUserMessage(decoded.content);
      } else if (decoded?.type === 'interrupt') {
        void this.interruptActiveTurn();
      }
    } catch (err: any) {
      writeLine(`[codex-app] bad botmux input: ${err?.message ?? err}`);
    }
    return;
  }
  this.handleUserMessage(line);
}

handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = this.inputBuffer;
      this.inputBuffer = '';
      this.enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
    } else {
      this.inputBuffer += ch;
    }
  }
}

}
