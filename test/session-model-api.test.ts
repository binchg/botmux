import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import * as sessions from '../src/services/session-store.js';
import * as workers from '../src/core/worker-pool.js';
import * as probe from '../src/services/codex-app-threads.js';
import { registerSessionModelApi } from '../src/core/session-model-api.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readSessionModel, writeSessionModelRuntime } from '../src/services/session-model-store.js';
let dir: string, previous: string, server: IpcServerHandle;
beforeEach(async () => {
  previous = config.session.dataDir; dir = mkdtempSync(join(tmpdir(), 'botmux-model-api-')); config.session.dataDir = dir;
  sessions.init('model-test'); workers.setActiveSessionsRegistry(new Map()); registerSessionModelApi('model-test');
  vi.spyOn(probe, 'listCodexAppModels').mockResolvedValue([{ model: 'synthetic-a', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' },{ reasoningEffort: 'xhigh' }], serviceTiers: [{ id: 'priority' }] }]);
  server = await startIpcServer(0);
});
afterEach(async () => { await server?.close(); vi.restoreAllMocks(); sessions.init(); workers.setActiveSessionsRegistry(new Map()); config.session.dataDir = previous; rmSync(dir, { recursive: true, force: true }); });
function session() { const s = sessions.createSession('chat', 'root', 'synthetic'); Object.assign(s, {larkAppId:'model-test',cliId:'codex-app',workingDir:dir}); sessions.updateSession(s); return s; }
async function update(id: string, body: unknown) { const r = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/model`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return { code:r.status, body:await r.json() }; }
it('only queues the legacy target for safe idle reload, without changing other session records', async () => {
  const a = session(), b = session(), send = vi.fn(); vi.spyOn(workers,'findActiveBySessionId').mockImplementation(id => id===a.sessionId ? {session:a,worker:{send,killed:false}} as any : undefined);
  const r = await update(a.sessionId,{model:'synthetic-a',effort:'xhigh',serviceTier:'priority'});
  expect(r.code).toBe(200); expect(r.body.status).toBe('pending_runner_reload'); expect(send).toHaveBeenCalledExactlyOnceWith({type:'reload_app_runner_when_idle'});
  expect(readSessionModel(dir,b.sessionId)).toBeUndefined(); expect(sessions.getSession(a.sessionId)).toEqual(a);
  writeSessionModelRuntime(dir,{sessionId:a.sessionId,pid:process.pid,phase:'ready'}); send.mockClear();
  expect((await update(a.sessionId,{effort:'high'})).body.status).toBe('pending_next_turn'); expect(send).not.toHaveBeenCalled(); expect(readSessionModel(dir,a.sessionId)?.serviceTier).toBe('priority');
});
it.each(['foreign','closed','adopted','other-cli','bad-effort'])('rejects %s before persisting a change', async kind => {
  const a=session(); if(kind==='foreign')a.larkAppId='another'; if(kind==='closed')a.status='closed'; if(kind==='other-cli')a.cliId='codex'; sessions.updateSession(a);
  if(kind==='adopted')vi.spyOn(workers,'findActiveBySessionId').mockReturnValue({session:a,adoptedFrom:{}} as any);
  const r=await update(a.sessionId,{model:'synthetic-a',effort:kind==='bad-effort'?'unsupported':'xhigh'});
  expect(r.code).toBe(409); expect(readSessionModel(dir,a.sessionId)).toBeUndefined();
});
it('rejects a session closed while the model catalog was being read', async () => {
  const a=session(); vi.mocked(probe.listCodexAppModels).mockImplementation(async()=>{sessions.closeSession(a.sessionId);return [{model:'synthetic-a',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];});
  expect((await update(a.sessionId,{model:'synthetic-a'})).code).toBe(409); expect(readSessionModel(dir,a.sessionId)).toBeUndefined();
});
it('uses the requested executor catalog and current runtime for executor-only and speed-only changes', async () => {
  const a=session();
  writeSessionModelRuntime(dir,{sessionId:a.sessionId,pid:process.pid,phase:'completed',selection:{model:'synthetic-a',effort:'xhigh',serviceTier:'priority',executor:'codex-app'}});
  const r=await update(a.sessionId,{executor:'traex'});
  expect(r.code).toBe(200);
  expect(probe.listCodexAppModels).toHaveBeenLastCalledWith({codexBin:'traex',cwd:dir});
  expect(readSessionModel(dir,a.sessionId)).toMatchObject({executor:'traex',model:'synthetic-a',effort:'xhigh',serviceTier:'default'});
  vi.mocked(probe.listCodexAppModels).mockResolvedValue([{model:'synthetic-a',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}],serviceTiers:[]}]);
  expect((await update(a.sessionId,{serviceTier:'priority'})).code).toBe(409);
  expect(readSessionModel(dir,a.sessionId)?.serviceTier).toBe('default');
});
