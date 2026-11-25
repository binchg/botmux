import { readCodexTopicSource, isCodexSubagent, isCodexFork } from './codex-topic-source.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { ExternalCodexBridge, type ExternalCodexBinding, type ExternalCodexOutputKind, type FollowupCard, type FollowupCheckpoint, type FollowupQuota } from './external-codex-bridge.js';

export interface AutoCodexBinding extends ExternalCodexBinding {
  codexHome: string;
  /** Legacy protection marker; normal replies still resume this exact thread. */
  readOnly: boolean;
  sourceThreadId?: string;
  targetKey?: string;
  firstUserMessage?: string;
  /** Auto-discovered child-agent bindings are retained only as routing tombstones. */
  suppressed?: boolean;
  /** Previous invalid topic roots are consumed so they cannot start a new bot session. */
  supersededRootMessageIds?: string[];
}
interface Baseline { offset: number; protected: boolean }
interface RetainedFollowup { root: string; sender: string; messageId: string; text: string }
interface Registry {
  initialized: boolean;
  startedAt: number;
  baselines: Record<string, Baseline>;
  bindings: Record<string, AutoCodexBinding>;
  pending?: Record<string, RetainedFollowup[]>;
}
export interface AutoCodexConfig {
  codexHomes: string[];
  larkAppId: string;
  chatId: string;
  ownerOpenId: string;
  replySenderOpenIds?: string[];
  allowGroupMembers?: boolean;
  protectedThreadIds?: string[];
}
export class CodexAutoBridge {
  private registry: Registry;
  private observers = new Map<string, ExternalCodexBridge>();
  private scanning = false;
  private protectedThreadIds: ReadonlySet<string>;
  private botmuxThreads = new Set<string>();
  private subagentThreads = new Set<string>();
  private routes = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(private cfg: AutoCodexConfig, private stateFile: string, private deps: {
    topic: (b: Omit<AutoCodexBinding, 'rootMessageId'>, uuid: string) => Promise<string>;
    findTopic?: (b: Omit<AutoCodexBinding, 'rootMessageId'>) => Promise<string | undefined>;
    reply: (b: AutoCodexBinding, text: string, uuid: string, kind?: ExternalCodexOutputKind) => Promise<unknown>;
    status?: (b: AutoCodexBinding, card: Readonly<FollowupCard>) => Promise<string | undefined>;
    statusQuota?: (b: AutoCodexBinding) => FollowupQuota | undefined;
    canProxy?: (b: AutoCodexBinding) => boolean;
    proxyEnqueue?: (b: AutoCodexBinding, text: string, clientId: string) => Promise<void>;
    received?: (b: AutoCodexBinding, messageId: string, text: string) => Promise<unknown>;
    turn: (b: AutoCodexBinding, text: string, checkpoint: FollowupCheckpoint, clientUserMessageId?: string) => Promise<void>;
    fork?: (b: AutoCodexBinding) => Promise<{ threadId: string; rolloutPath: string }>;
    excluded: () => Set<string>;
    error: (error: unknown) => void;
  }) {
    this.protectedThreadIds = new Set(cfg.protectedThreadIds);
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    this.registry = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { initialized: false, startedAt: Date.now(), baselines: {}, bindings: {} };
    for (const [key, b] of Object.entries(this.registry.bindings)) {
      this.restoreObserver(key, b);
    }
  }

  private verifiedSource(b: AutoCodexBinding, path: string) {
    try {
      const library = realpathSync(b.codexHome);
      const distance = relative(library, realpathSync(path));
      if (!['sessions', 'archived_sessions'].includes(distance.split(sep)[0])) return;
      const source = readCodexTopicSource(path);
      return source.meta?.id === b.threadId ? source : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.error(error);
    }
  }

  private restoreObserver(key: string, b: AutoCodexBinding): void {
    if (this.isManaged(b) || !this.canRoute(b)) return;
    const archived = join(b.codexHome, 'archived_sessions', basename(b.rolloutPath));
    const stored = this.verifiedSource(b, b.rolloutPath);
    const source = stored ?? this.verifiedSource(b, archived);
    if (!source) return;
    const meta = source.meta!;
    let changed = !stored;
    if (isCodexSubagent(meta)) {
      this.subagentThreads.add(b.threadId);
      changed ||= !b.suppressed;
      b.suppressed = true;
    }
    if (typeof meta.originator === 'string' && /^botmux(?:-|$)/.test(meta.originator)) this.botmuxThreads.add(b.threadId);
    if (!stored) {
      this.registry.baselines[archived] ??= this.registry.baselines[b.rolloutPath]
        ?? { offset: this.completeOffset(archived, statSync(archived).size), protected: true };
      b.rolloutPath = archived;
    }
    if (source.firstUserMessage && source.firstUserMessage !== b.firstUserMessage) {
      b.firstUserMessage = source.firstUserMessage;
      changed = true;
    }
    if (typeof meta.forked_from_id === 'string' && meta.forked_from_id !== b.sourceThreadId) {
      b.sourceThreadId = meta.forked_from_id;
      changed = true;
    }
    if (changed) this.save();
    try { if (!this.isManaged(b)) this.observe(key, b); }
    catch (error) { this.deps.error(error); }
  }

  private isManaged(b: AutoCodexBinding): boolean {
    return b.suppressed === true || this.subagentThreads.has(b.threadId) || this.botmuxThreads.has(b.threadId) || this.deps.excluded().has(b.threadId);
  }
  private save(): void { atomicWriteFileSync(this.stateFile, JSON.stringify(this.registry, null, 2), { mode: 0o600 }); }
  private key(home: string, id: string): string { return createHash('sha256').update(`${home}:${id}`).digest('hex'); }
  private canRoute(b: AutoCodexBinding): boolean {
    return b.larkAppId === this.cfg.larkAppId && b.chatId === this.cfg.chatId && this.cfg.codexHomes.includes(b.codexHome)
      && !Object.values(this.registry.bindings).some(other => other !== b && other.larkAppId === b.larkAppId
        && (other.rootMessageId === b.rootMessageId || other.threadId === b.threadId) && !this.isManaged(other));
  }
  private observe(key: string, b: AutoCodexBinding, offset?: number): ExternalCodexBridge {
    const observer = new ExternalCodexBridge([{ ...b, replySenderOpenIds: this.cfg.replySenderOpenIds,
      allowGroupMembers: this.cfg.allowGroupMembers }], join(dirname(this.stateFile), `${key}.json`), {
      reply: async (source, text, uuid, kind) => { if (!this.isManaged(b)) await this.deps.reply({ ...b, currentUserMessage: source.currentUserMessage }, text, uuid, kind); },
      canProxy: () => !this.isManaged(b) && this.deps.canProxy?.(b) === true,
      proxyEnqueue: async (_, text, clientId) => { if (!this.isManaged(b)) await this.deps.proxyEnqueue?.(b, text, clientId); },
      isProtected: () => this.protectedThreadIds.has(b.threadId),
      status: this.deps.status && (async (_, card) => !this.isManaged(b) ? this.deps.status!(b, card) : undefined),
      statusQuota: this.deps.statusQuota && (() => !this.isManaged(b) ? this.deps.statusQuota!(b) : undefined),
      received: async (_, messageId, text) => { if (!this.isManaged(b)) await this.deps.received?.(b, messageId, text); },
      turn: async (_, text, checkpoint, clientUserMessageId) => { if (!this.isManaged(b)) await this.deps.turn(b, text, checkpoint, clientUserMessageId); }, error: this.deps.error,
    }, offset === undefined ? undefined : { [b.threadId]: offset }, this.registry.startedAt);
    this.observers.set(key, observer);
    return observer;
  }
  owns(root: string, app: string): boolean {
    return Object.values(this.registry.bindings).some(b => (b.rootMessageId === root || b.supersededRootMessageIds?.includes(root)) && b.larkAppId === app && !this.isManaged(b));
  }
  isBusy(root: string, app: string): boolean {
    for (const observer of this.observers.values()) if (observer.owns(root, app)) return observer.isBusy(root, app);
    return false;
  }
  followupStatus(root: string, app: string) {
    if (!this.owns(root, app)) return undefined;
    for (const [key, b] of Object.entries(this.registry.bindings)) {
      if (b.rootMessageId !== root || b.larkAppId !== app || !this.canRoute(b)) continue;
      const queued = this.registry.pending?.[key]?.filter(input => input.root === root).length ?? 0;
      const status = this.observers.get(key)?.followupStatus(root, app);
      if (queued) return { phase: 'waiting_owner', running: status?.running ?? false, queued: queued + (status?.queued ?? 0) };
      return status;
    }
    return undefined;
  }
  hasReceived(root: string, app: string, messageId: string): boolean {
    if (!this.owns(root, app)) return false;
    for (const [key, b] of Object.entries(this.registry.bindings)) {
      if (b.rootMessageId === root && b.larkAppId === app && this.canRoute(b)
        && this.registry.pending?.[key]?.some(input => input.root === root && input.messageId === messageId)) return true;
    }
    for (const observer of this.observers.values()) if (observer.owns(root, app)) return observer.hasReceived(root, app, messageId);
    return false;
  }
  async receive(root: string, app: string, sender: string, messageId: string, text: string, chatId?: string): Promise<boolean> {
    const matches = Object.entries(this.registry.bindings).filter(([, b]) => (b.rootMessageId === root || b.supersededRootMessageIds?.includes(root)) && b.larkAppId === app);
    if (matches.length > 1) return true;
    const found = matches[0];
    if (!found) return false;
    if (found[1].rootMessageId !== root) return true;
    // A recalled erroneous child topic must never fall through to a fresh bot session.
    if (found[1].suppressed || this.subagentThreads.has(found[1].threadId)) return true;
    if (this.isManaged(found[1])) return false;
    if ((chatId !== undefined && chatId !== found[1].chatId) || !this.canRoute(found[1])) return true;
    if (sender !== this.cfg.ownerOpenId && !this.cfg.replySenderOpenIds?.includes(sender)
        && !(this.cfg.allowGroupMembers && sender.startsWith('ou_'))) return true;
    const [key, source] = found;
    if (this.hasReceived(root, app, messageId)) return true;
    ((this.registry.pending ??= {})[key] ??= []).push({ root, sender, messageId, text });
    this.save();
    await this.drainRetained(key, source);
    return true;
  }

  private async drainRetained(key: string, b: AutoCodexBinding): Promise<void> {
    const inFlight = this.routes.get(key);
    if (inFlight) return inFlight;
    if (!this.registry.pending?.[key]?.length || this.isManaged(b) || !this.canRoute(b)) return;
    const observer = this.observers.get(key);
    if (!observer || !this.verifiedSource(b, b.rolloutPath)) return;
    const operation = (async () => {
      const queue = this.registry.pending![key];
      while (this.canRoute(b) && !this.isManaged(b)) {
        const index = queue.findIndex(input => input.root === b.rootMessageId);
        if (index === -1) break;
        const input = queue[index];
        if (!await observer.receive(input.root, b.larkAppId, input.sender, input.messageId, input.text, b.chatId)) break;
        queue.splice(index, 1);
        if (!queue.length) delete this.registry.pending![key];
        this.save();
      }
    })();
    this.routes.set(key, operation);
    try { await operation; } finally { if (this.routes.get(key) === operation) this.routes.delete(key); }
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
    const recoveries: Promise<void>[] = [];
    try {
      const excluded = this.deps.excluded();
      for (const [key, b] of Object.entries(this.registry.bindings)) {
        if (this.isManaged(b) || !this.canRoute(b)) this.observers.delete(key);
        else if (!this.observers.has(key) || !existsSync(b.rolloutPath)) {
          this.observers.delete(key);
          this.restoreObserver(key, b);
        }
        if (this.registry.pending?.[key]?.length) recoveries.push(this.drainRetained(key, b).catch(this.deps.error));
      }
      let changed = !this.registry.initialized;
      const boundPaths = new Map(Object.values(this.registry.bindings).map(b => [b.rolloutPath, b.threadId]));
      for (const home of this.cfg.codexHomes) for (const path of this.files(join(home, 'sessions'))) {
        let size: number;
        try { size = statSync(path).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (!size) continue;
        let baseline = this.registry.baselines[path];
        if (!baseline) {
          baseline = this.registry.baselines[path] = { offset: this.registry.initialized ? 0 : this.completeOffset(path, size), protected: !this.registry.initialized };
          changed = true;
        }
        if (size <= baseline.offset) continue;
        let source;
        try { source = readCodexTopicSource(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const meta = source.meta;
        if (typeof meta?.id !== 'string') continue;
        const id = meta.id, key = this.key(home, id);
        if (boundPaths.has(path) && boundPaths.get(path) !== id) continue;
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
        if (priorBinding && priorBinding.rolloutPath !== path && this.canRoute(priorBinding)
          && !this.verifiedSource(priorBinding, priorBinding.rolloutPath) && this.verifiedSource(priorBinding, path)) {
          priorBinding.rolloutPath = path;
          boundPaths.set(path, id);
          this.observe(key, priorBinding);
          changed = true;
        }
        if (priorBinding && (priorBinding.rolloutPath !== path || !this.canRoute(priorBinding))) continue;
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
          let recoveredRoot: string | undefined;
          if (!priorBinding && this.deps.findTopic) {
            try { recoveredRoot = await this.deps.findTopic(candidate); }
            catch (error) { this.deps.error(error); continue; }
          }
          const rootMessageId = priorBinding?.rootMessageId
            ?? recoveredRoot
            ?? await this.deps.topic(candidate, key.slice(0, 32));
          const binding = { ...candidate, ...priorBinding, rolloutPath: path, rootMessageId };
          if (!this.canRoute(priorBinding ?? binding)) {
            this.deps.error(new Error(`Conflicting topic or Codex ID for ${id}; binding deferred`));
            continue;
          }
          this.registry.bindings[key] = binding;
          boundPaths.set(path, id);
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
    await Promise.all(recoveries);
  }
  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => { void this.scan().catch(this.deps.error); }, 2000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
