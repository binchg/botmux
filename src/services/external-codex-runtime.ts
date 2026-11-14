import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { replyMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { ExternalCodexBridge, type ExternalCodexBinding } from './external-codex-bridge.js';

export let externalCodexBridge: ExternalCodexBridge | undefined;

export function startExternalCodexBridge(): void {
  const configPath = join(homedir(), '.config/botmux/external-codex.json');
  if (!existsSync(configPath)) return;
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  if (cfg.enabled !== true) return;
  if (!Array.isArray(cfg.bindings) || !cfg.codexHome || !cfg.codexBin) throw new Error('Invalid external Codex bridge config');
  for (const b of cfg.bindings) {
    for (const field of ['threadId', 'sourceThreadId', 'rolloutPath', 'cwd', 'chatId', 'larkAppId', 'ownerOpenId', 'rootMessageId']) {
      if (typeof b[field] !== 'string' || !b[field]) throw new Error(`Missing external Codex binding ${field}`);
    }
    if (b.threadId === b.sourceThreadId) throw new Error('Refusing to bind the original Codex archive');
  }
  const statePath = join(homedir(), '.local/state/botmux/external-codex.json');
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  externalCodexBridge = new ExternalCodexBridge(cfg.bindings, statePath, {
    reply: (b, text, uuid) => replyMessage(b.larkAppId, b.rootMessageId, text, 'text', true, uuid),
    turn: (b, text, checkpoint) => runExternalCodexTurn(cfg.codexBin, cfg.codexHome, b, text, checkpoint),
    error: e => logger.error(`[external-codex] ${String(e)}`),
  });
  externalCodexBridge.start();
  logger.info(`[external-codex] observing ${cfg.bindings.length} explicitly bound fork(s)`);
}

export async function runExternalCodexTurn(binary: string, codexHome: string, b: ExternalCodexBinding, text: string, checkpoint: () => void): Promise<void> {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: b.cwd, env: { ...process.env, HOME: homedir(), CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let seq = 0, buffer = '', turnId: string | undefined;
  const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  let finish!: () => void, fail!: (e: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Attach a rejection handler before initialize/resume can fail.
  void completed.catch(() => {});
  const die = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); fail(e); };
  const timer = setTimeout(() => { die(new Error('External Codex turn timed out; input retained for inspection')); child.kill(); }, 300_000);
  child.on('error', die);
  child.stdin.on('error', die);
  child.on('exit', () => die(new Error('External Codex app-server exited')));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!; pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      } else if (msg.method === 'turn/completed' && msg.params?.threadId === b.threadId) {
        if (turnId && msg.params.turn?.id !== turnId) continue;
        if (msg.params.turn?.status === 'failed') fail(new Error('External Codex turn failed'));
        else finish();
      }
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'botmux-external-codex', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    await request('thread/resume', {
      threadId: b.threadId, cwd: b.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
      persistExtendedHistory: true,
    });
    checkpoint();
    const started = await request('turn/start', { threadId: b.threadId, input: [{ type: 'text', text }] });
    turnId = started.turn?.id;
    await completed;
  } finally { clearTimeout(timer); child.kill(); }
}
