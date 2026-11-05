import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { beginSessionModelReplyEpoch, formatSessionModelReply, isTraexModelReply } from '../src/services/session-model-reply-budget.js';
import { sessionModelDisplay, withSessionModelDisplay } from '../src/services/session-model-display.js';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'reply-budget-')); roots.push(p); return p; };
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const display = sessionModelDisplay({ sessionId: 'test', pid: process.pid, protocol: 4, phase: 'running',
  updatedAt: new Date().toISOString(), selection: { executor: 'traex', model: 'gpt-6.1-sol', effort: 'xhigh' },
  routing: { executor: 'traex', effort: 'xhigh', loadPercent: 86 } });
const stamped = (text: string) => withSessionModelDisplay(text, display);

describe('shared model reply budget', () => {
  it('shares first two labels across automatic and explicit replies; final is always labeled', () => {
    const dir = temp(); beginSessionModelReplyEpoch(dir, 's');
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('auto first')))).toBe(true);
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', 'explicit second', false, display))).toBe(true);
    expect(formatSessionModelReply(dir, 's', stamped('auto middle'))).toBe('auto middle');
    expect(formatSessionModelReply(dir, 's', 'explicit middle', false, display)).toBe('explicit middle');
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('last'), true))).toBe(true);
    beginSessionModelReplyEpoch(dir, 's');
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('follow-up first')))).toBe(true);
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('follow-up second')))).toBe(true);
    // Automatic reselection changes actual model, not user epoch.
    expect(formatSessionModelReply(dir, 's', stamped('reselected middle'))).toBe('reselected middle');
    expect(isTraexModelReply(formatSessionModelReply(dir, 'other', stamped('other session')))).toBe(true);
  });

  it('does not consume a budget for empty, machine JSON or non-TraeX messages', () => {
    const dir = temp();
    const json = '{"attemptId":"a","revisionId":"r","status":"success","summary":"ok","evidenceRefs":[],"metrics":{}}';
    for (const text of ['', json, 'ordinary message']) expect(formatSessionModelReply(dir, 's', text)).toBe(text);
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('first')))).toBe(true);
    expect(isTraexModelReply(formatSessionModelReply(dir, 's', stamped('second')))).toBe(true);
  });

  it('serializes reservations across processes and stores no message body', async () => {
    const dir = temp(); beginSessionModelReplyEpoch(dir, 's');
    const modulePath = resolve('src/services/session-model-reply-budget.ts');
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `import {formatSessionModelReply} from ${JSON.stringify(modulePath)};process.stdout.write(formatSessionModelReply(${JSON.stringify(dir)},'s',${JSON.stringify(stamped('private body'))}));`]);
      let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(err)));
    });
    const outputs = await Promise.all(Array.from({ length: 6 }, run));
    expect(outputs.filter(isTraexModelReply)).toHaveLength(2);
    const { readdirSync } = await import('node:fs');
    const path = join(dir, 'session-models', readdirSync(join(dir, 'session-models')).find(x => x.endsWith('.reply-budget.json'))!);
    expect(readFileSync(path, 'utf8')).not.toContain('private body');
  }, 15000);
});
