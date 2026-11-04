import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionModelDisplay, sessionModelDisplay, withSessionModelDisplay } from '../src/services/session-model-display.js';
import { writeSessionModel, writeSessionModelRuntime, type SessionModelRuntime } from '../src/services/session-model-store.js';
import { buildMarkdownCard } from '../src/im/lark/md-card.js';

const roots: string[] = [];
const runtime = (model = 'gpt-6.1-sol'): SessionModelRuntime => ({
  sessionId: 'test', pid: process.pid, protocol: 4, phase: 'running', updatedAt: new Date().toISOString(),
  selection: { executor: 'traex', model, effort: 'xhigh' },
});
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));

describe('actual TraeX model display', () => {
  it('stamps replies with the actual model, not the desired default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-display-')); roots.push(dir);
    writeSessionModel(dir, 'test', { executor: 'traex', model: 'gpt-5.6-sol', effort: 'xhigh' });
    writeSessionModelRuntime(dir, runtime());
    const display = readSessionModelDisplay(dir, 'test');
    expect(display?.label).toContain('TraeX · GPT-6.1-Sol · xhigh');
    const text = withSessionModelDisplay('实际答复', display);
    expect(text).toContain('模型：TraeX · GPT-6.1-Sol · xhigh');
    expect(text).not.toContain('5.6');
    expect(withSessionModelDisplay(text, display)).toBe(text);
    expect(buildMarkdownCard(text)).toContain('GPT-6.1-Sol');
  });

  it('clears the old model during selection or waiting and distinguishes candidates and queue evidence', () => {
    const old = runtime('gpt-6-astra');
    for (const state of ['selecting', 'waiting'] as const) {
      const display = sessionModelDisplay({ ...old, phase: 'ready', routing: { executor: 'traex', state, effort: 'xhigh' } });
      expect(display?.model).toBeNull();
      expect(display?.label).not.toContain('Astra');
      expect(display?.label).toContain('尚未选定模型');
    }
    expect(sessionModelDisplay({ ...old, phase: 'ready' })?.label).toContain('候选，待请求');
    const queued = sessionModelDisplay({ ...old, routing: { executor: 'traex', state: 'queued', effort: 'xhigh', position: 7, loadPercent: 92 } });
    expect(queued?.label).toContain('排队，重选中 · 第 7 位 · 选模负载 92%');
    expect(queued?.label).not.toContain('不排队');
  });

  it('does not display desired-only, stopped-as-running, corrupt metadata or machine JSON', () => {
    expect(sessionModelDisplay(undefined)).toBeNull();
    expect(sessionModelDisplay({ ...runtime(), selection: { executor: 'codex-app', model: 'gpt-6.1-sol', effort: 'xhigh' } })).toBeNull();
    expect(sessionModelDisplay(runtime(), false)?.label).toContain('运行器已停止');
    expect(sessionModelDisplay(runtime('<script>'))?.model).toBeNull();
    const json = '{"attemptId":"a","revisionId":"r","status":"success","summary":"ok","evidenceRefs":[],"metrics":{}}';
    expect(withSessionModelDisplay(json, sessionModelDisplay(runtime()))).toBe(json);
    expect(withSessionModelDisplay('', sessionModelDisplay(runtime()))).toBe('');
    const dir = mkdtempSync(join(tmpdir(), 'model-display-')); roots.push(dir);
    writeFileSync(join(dir, 'bad.json'), json);
    expect(readSessionModelDisplay(dir, 'missing')).toBeNull();
  });
});
