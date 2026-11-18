import { readCodexTopicSource, isCodexSubagent, isCodexFork } from './codex-topic-source.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { ExternalCodexBridge, type ExternalCodexBinding, type ExternalCodexOutputKind } from './external-codex-bridge.js';

export interface AutoCodexBinding extends ExternalCodexBinding {
  codexHome: string;
  /** Legacy protection marker; normal replies still resume this exact thread. */
  readOnly: boolean;
  sourceThreadId?: string;
  targetKey?: string;
  firstUserMessage?: string;
  /** Auto-discovered child-agent bindings are retained only as routing tombstones. */
  suppressed?: boolean;
}
interface Baseline { offset: number; protected: boolean }
interface Registry {
  initialized: boolean;
  startedAt: number;
  baselines: Record<string, Baseline>;
  bindings: Record<string, AutoCodexBinding>;
}
export interface AutoCodexConfig {
  codexHomes: string[];
  writableThreadIds?: string[];
  larkAppId: string;
  chatId: string;
  ownerOpenId: string;
  replySenderOpenIds?: string[];
  allowGroupMembers?: boolean;
}
export class CodexAutoBridge {
  private registry: Registry;
  private observers = new Map<string, ExternalCodexBridge>();
  private scanning = false;
  private botmuxThreads = new Set<string>();
  private subagentThreads = new Set<string>();
  private routes = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(private cfg: AutoCodexConfig, private stateFile: string, private deps: {
    topic: (b: Omit<AutoCodexBinding, 'rootMessageId'>, uuid: string) => Promise<string>;
    reply: (b: AutoCodexBinding, text: string, uuid: string, kind?: ExternalCodexOutputKind) => Promise<unknown>;
    received?: (b: AutoCodexBinding, messageId: string, text: string) => Promise<unknown>;
    turn: (b: AutoCodexBinding, text: string, checkpoint: (submitted?: boolean) => void, clientUserMessageId?: string) => Promise<void>;
    fork?: (b: AutoCodexBinding) => Promise<{ threadId: string; rolloutPath: string }>;
    excluded: () => Set<string>;
    error: (error: unknown) => void;
  }) {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    this.registry = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { initialized: false, startedAt: Date.now(), baselines: {}, bindings: {} };
    for (const [key, b] of Object.entries(this.registry.bindings)) {
      if (existsSync(b.rolloutPath)) {
        const meta = readCodexTopicSource(b.rolloutPath).meta;
        if (typeof meta?.forked_from_id === 'string') b.sourceThreadId = meta.forked_from_id;
        if (isCodexSubagent(meta)) { this.subagentThreads.add(b.threadId); b.suppressed = true; }
        this.rememberOrigin(b.rolloutPath);
        if (!this.isManaged(b)) this.observe(key, b);
      }
      else this.deps.error(new Error(`Codex transcript unavailable for ${b.threadId}; other sessions remain active`));
    }
  }
  private rememberOrigin(path: string): void {
    const meta = readCodexTopicSource(path).meta;
    const originator = meta?.originator;
    if (typeof originator === 'string' && /^botmux(?:-|$)/.test(originator)) {
      this.botmuxThreads.add(meta!.id);
    }
  }
  private isManaged(b: AutoCodexBinding): boolean {
    return b.suppressed === true || this.subagentThreads.has(b.threadId) || this.botmuxThreads.has(b.threadId) || this.deps.excluded().has(b.threadId);
  }
  private save(): void { atomicWriteFileSync(this.stateFile, JSON.stringify(this.registry, null, 2), { mode: 0o600 }); }
  private key(home: string, id: string): string { return createHash('sha256').update(`${home}:${id}`).digest('hex'); }
  private observe(key: string, b: AutoCodexBinding, offset?: number): ExternalCodexBridge {
    const observer = new ExternalCodexBridge([{ ...b, replySenderOpenIds: this.cfg.replySenderOpenIds,
      allowGroupMembers: this.cfg.allowGroupMembers }], join(dirname(this.stateFile), `${key}.json`), {
      reply: async (source, text, uuid, kind) => { if (!this.isManaged(b)) await this.deps.reply({ ...b, currentUserMessage: source.currentUserMessage }, text, uuid, kind); },
      received: async (_, messageId, text) => { if (!this.isManaged(b)) await this.deps.received?.(b, messageId, text); },
      turn: async (_, text, checkpoint, clientUserMessageId) => { if (!this.isManaged(b)) await this.deps.turn(b, text, checkpoint, clientUserMessageId); }, error: this.deps.error,
    }, offset === undefined ? undefined : { [b.threadId]: offset }, this.registry.startedAt);
    this.observers.set(key, observer);
    return observer;
  }
  owns(root: string, app: string): boolean {
    return Object.values(this.registry.bindings).some(b => b.rootMessageId === root && b.larkAppId === app && !this.isManaged(b));
  }
  isBusy(root: string, app: string): boolean {
    for (const observer of this.observers.values()) if (observer.owns(root, app)) return observer.isBusy(root, app);
    return false;
  }
  async receive(root: string, app: string, sender: string, messageId: string, text: string): Promise<boolean> {
    const found = Object.entries(this.registry.bindings).find(([, b]) => b.rootMessageId === root && b.larkAppId === app);
    if (!found) return false;
    // A recalled erroneous child topic must never fall through to a fresh bot session.
    if (found[1].suppressed || this.subagentThreads.has(found[1].threadId)) return true;
    if (this.isManaged(found[1])) return false;
    if (sender !== this.cfg.ownerOpenId && !this.cfg.replySenderOpenIds?.includes(sender)
        && !(this.cfg.allowGroupMembers && sender.startsWith('ou_'))) return true;
    const [key, source] = found;
    const previous = this.routes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.isManaged(source)) return;
      // A normal follow-up always resumes the thread explicitly bound to this
      // topic. Historical readOnly/targetKey flags must never create or select
      // a test fork. Explicit test topics bind the fork's own threadId.
      const targetKey = key;
      const target = source;
      if (target && !this.isManaged(target)) {
        await this.observers.get(targetKey)?.receive(root, app, sender, messageId, text);
      }
    });
    this.routes.set(key, operation);
    try { await operation; } finally { if (this.routes.get(key) === operation) this.routes.delete(key); }
    return true;
  }
  private files(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...this.files(path));
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) result.push(path);
    }
    return result;
  }
  private completeOffset(path: string, size: number): number {
    const fd = openSync(path, 'r');
    try {
      const length = Math.min(size, 1024 * 1024), data = Buffer.alloc(length);
      readSync(fd, data, 0, length, size - length);
      const newline = data.lastIndexOf(10);
      return newline < 0 ? 0 : size - length + newline + 1;
    } finally { closeSync(fd); }
  }
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const excluded = this.deps.excluded();
      for (const [key, b] of Object.entries(this.registry.bindings)) {
        if (this.isManaged(b)) this.observers.delete(key);
      }
      let changed = !this.registry.initialized;
      for (const home of this.cfg.codexHomes) for (const path of this.files(join(home, 'sessions'))) {
        const size = statSync(path).size;
        if (!size) continue;
        let baseline = this.registry.baselines[path];
        if (!baseline) {
          baseline = this.registry.baselines[path] = { offset: this.registry.initialized ? 0 : this.completeOffset(path, size), protected: !this.registry.initialized };
          changed = true;
        }
        if (size <= baseline.offset) continue;
        const source = readCodexTopicSource(path);
        const meta = source.meta;
        if (typeof meta?.id !== 'string') continue;
        const id = meta.id, key = this.key(home, id);
        if (isCodexSubagent(meta)) {
          this.subagentThreads.add(id);
          if (this.registry.bindings[key]) this.registry.bindings[key].suppressed = true;
          this.observers.delete(key);
          baseline.offset = size;
          changed = true;
          continue;
        }
        // Discover main conversations only. Existing explicit test-fork topics
        // keep their own bindings; never rebind them to their parent.
        if (isCodexFork(meta) && !this.registry.bindings[key]) {
          baseline.offset = size;
          changed = true;
          continue;
        }
        if (typeof meta.originator === 'string' && /^botmux(?:-|$)/.test(meta.originator)) {
          this.botmuxThreads.add(id);
        }
        if (excluded.has(id) || this.botmuxThreads.has(id)) {
          this.observers.delete(key);
          baseline.offset = size;
          changed = true;
          continue;
        }
        const priorBinding = this.registry.bindings[key];
        // Imported copies in another library are the same conversation, not
        // another task or another place to resume a model. Preserve the first binding.
        const sameThread = Object.entries(this.registry.bindings).find(([other, b]) => other !== key && b.threadId === id && !this.isManaged(b));
        if (!priorBinding && sameThread) {
          baseline.offset = size; changed = true; continue;
        }
        if (priorBinding && priorBinding.rolloutPath !== path && !excluded.has(id)) {
          priorBinding.rolloutPath = path;
          this.observe(key, priorBinding);
          changed = true;
        }
        if (!excluded.has(id) && !this.observers.has(key)) {
          // A Hook/completion alone is never enough to create a topic.
          if (!priorBinding && !source.firstUserMessage) continue;
          const candidate = {
            threadId: id, rolloutPath: path, cwd: meta.cwd, codexHome: home,
            larkAppId: this.cfg.larkAppId, chatId: this.cfg.chatId, ownerOpenId: this.cfg.ownerOpenId,
            readOnly: false,
            ...(source.firstUserMessage ? { firstUserMessage: source.firstUserMessage } : {}),
            ...(typeof meta.forked_from_id === 'string' ? { sourceThreadId: meta.forked_from_id } : {}),
          };
          if (typeof candidate.cwd !== 'string') continue;
          const rootMessageId = priorBinding?.rootMessageId ?? await this.deps.topic(candidate, key.slice(0, 32));
          const binding = { ...candidate, ...priorBinding, rolloutPath: path, rootMessageId };
          this.registry.bindings[key] = binding;
          this.save();
          this.observe(key, binding, Math.max(baseline.offset, source.firstUserOffset ?? 0));
        }
        baseline.offset = size;
        changed = true;
      }
      this.registry.initialized = true;
      if (changed) this.save();
    } finally { this.scanning = false; }
    for (const observer of this.observers.values()) {
      // Keep scanning and forwarding other threads while one model runs.
      void observer.tick().catch(this.deps.error);
    }
  }
  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => { void this.scan().catch(this.deps.error); }, 2000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
