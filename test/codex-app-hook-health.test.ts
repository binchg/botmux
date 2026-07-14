import { describe, expect, it } from 'vitest';
import { codexAppHookFailure, codexAppHookTrustIssue } from '../src/services/codex-app-hook-health.js';

describe('Codex App hook health', () => {
  it('reports enabled modified project hooks before a turn starts', () => {
    const issue = codexAppHookTrustIssue({
      data: [{
        cwd: '/repo',
        hooks: [
          { eventName: 'userPromptSubmit', enabled: true, isManaged: false, trustStatus: 'modified' },
          { eventName: 'postToolUse', enabled: false, isManaged: false, trustStatus: 'untrusted' },
          { eventName: 'stop', enabled: true, isManaged: true, trustStatus: 'managed' },
        ],
        errors: [],
      }],
    }, '/repo');

    expect(issue).toContain('userPromptSubmit');
    expect(issue).toContain('modified');
    expect(issue).not.toContain('postToolUse');
  });

  it('accepts enabled trusted hooks', () => {
    expect(codexAppHookTrustIssue({
      data: [{ cwd: '/repo', hooks: [{ enabled: true, trustStatus: 'trusted' }], errors: [] }],
    }, '/repo')).toBeUndefined();
  });

  it('marks UserPromptSubmit runtime failures as critical', () => {
    expect(codexAppHookFailure({
      eventName: 'userPromptSubmit',
      status: 'failed',
      sourcePath: '/repo/.codex/hooks.json',
      entries: [{ kind: 'error', text: 'hook exited with code 1' }],
    })).toEqual({
      message: 'Codex Hook userPromptSubmit failed：hook exited with code 1（/repo/.codex/hooks.json）',
      critical: true,
    });
  });
});
