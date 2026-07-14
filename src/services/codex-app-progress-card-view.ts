export type CodexAppProgressCardViewKind = 'assistant' | 'heartbeat';

export interface CodexAppProgressCardViewOptions {
  maxAssistantEntries?: number;
  maxAssistantChars?: number;
}

const DEFAULT_MAX_ASSISTANT_ENTRIES = 4;
const DEFAULT_MAX_ASSISTANT_CHARS = 220;

function compactLine(value: string, maxChars: number): string {
  const normalized = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Heartbeats already carry a compact copy of the last assistant sentence.
 * Remove that duplicate before rendering the heartbeat below the durable
 * assistant history. */
function heartbeatStatus(value: string, maxChars: number): string {
  return compactLine(value.replace(/｜进展：[\s\S]*?(?=｜本轮)/, ''), maxChars);
}

/** Builds one mutable Lark card without letting periodic status overwrite the
 * assistant's latest verified decisions. */
export class CodexAppProgressCardView {
  private readonly maxAssistantEntries: number;
  private readonly maxAssistantChars: number;
  private assistantEntries: string[] = [];
  private status = '';

  constructor(options: CodexAppProgressCardViewOptions = {}) {
    this.maxAssistantEntries = Math.max(1, options.maxAssistantEntries ?? DEFAULT_MAX_ASSISTANT_ENTRIES);
    this.maxAssistantChars = Math.max(16, options.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS);
  }

  reset(): void {
    this.assistantEntries = [];
    this.status = '';
  }

  update(kind: CodexAppProgressCardViewKind, content: string): string {
    if (kind === 'heartbeat') {
      this.status = heartbeatStatus(content, this.maxAssistantChars);
    } else {
      const entry = compactLine(content, this.maxAssistantChars);
      if (entry && this.assistantEntries.at(-1) !== entry) {
        this.assistantEntries.push(entry);
        this.assistantEntries = this.assistantEntries.slice(-this.maxAssistantEntries);
      }
    }
    return this.render();
  }

  render(): string {
    const sections: string[] = [];
    if (this.assistantEntries.length > 0) {
      sections.push(`**最新进展**\n${this.assistantEntries.map(item => `- ${item}`).join('\n')}`);
    }
    if (this.status) sections.push(this.status);
    return sections.join('\n\n');
  }
}
