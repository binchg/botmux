import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { findCodexVscodeFrame, sameCodexVscodeThread } from '../src/services/codex-vscode-ssh.js';

const frame = {
  type: 'iframe',
  url: 'vscode-webview://example/index.html?extensionId=openai.chatgpt&amp;remoteAuthority=ssh-remote%2Bdev5090&amp;purpose=webviewView',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9338/devtools/page/target',
};

it('requires a unique native Codex frame in the configured remote SSH window', () => {
  expect(findCodexVscodeFrame([frame], 'ssh-remote+dev5090')).toBe(frame);
  expect(findCodexVscodeFrame([frame], 'ssh-remote+dev5080')).toBeUndefined();
  expect(findCodexVscodeFrame([frame, { ...frame }], 'ssh-remote+dev5090')).toBeUndefined();
});

it('refuses a different thread ID or a copy of the original transcript in another library', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-vscode-identity-'));
  const original = join(dir, 'original.jsonl');
  const copy = join(dir, 'copy.jsonl');
  try {
    writeFileSync(original, '');
    writeFileSync(copy, '');
    expect(sameCodexVscodeThread({ id: 'original', path: original }, 'original', original)).toBe(true);
    expect(sameCodexVscodeThread({ id: 'original', path: copy }, 'original', original)).toBe(false);
    expect(sameCodexVscodeThread({ id: 'fork', path: original }, 'original', original)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
