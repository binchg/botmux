#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveDist = join(repoRoot, 'dist');
const stagingDist = join(repoRoot, `.dist-staging-${process.pid}-${Date.now()}`);

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')} 失败（${result.status ?? 'spawn'}）`);
}

/** Linux renameat2(RENAME_EXCHANGE) atomically swaps two non-empty directories.
 * The tracked source is fed to cc over stdin; no helper binary enters the repo. */
function exchangeDirectoriesLinux(left, right) {
  const helper = join(repoRoot, `.dist-exchange-${process.pid}`);
  const source = `
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/fs.h>
#include <fcntl.h>
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE) != 0) {
    perror("renameat2(RENAME_EXCHANGE)");
    return errno ? errno : 1;
  }
  return 0;
}`;
  try {
    run('cc', ['-x', 'c', '-O2', '-o', helper, '-'], { input: source });
    run(helper, [left, right]);
  } finally {
    rmSync(helper, { force: true });
  }
}

function publishStagingDist() {
  if (!existsSync(liveDist)) {
    renameSync(stagingDist, liveDist);
    return;
  }
  if (process.platform !== 'linux') {
    throw new Error('已有 dist 的零窗口发布当前仅支持 Linux renameat2(RENAME_EXCHANGE)');
  }
  exchangeDirectoriesLinux(stagingDist, liveDist);
  // The old live tree is now at stagingDist; removing it cannot open a gap at dist.
  rmSync(stagingDist, { recursive: true, force: true });
}

try {
  run('corepack', ['pnpm', 'exec', 'tsc', '--outDir', stagingDist]);
  mkdirSync(join(stagingDist, 'setup'), { recursive: true });
  copyFileSync(join(repoRoot, 'src', 'setup', 'lark-scopes.json'), join(stagingDist, 'setup', 'lark-scopes.json'));
  run(process.execPath, [join(repoRoot, 'scripts', 'build-dashboard.mjs')], {
    env: { BOTMUX_DIST_DIR: stagingDist },
  });
  chmodSync(join(stagingDist, 'cli.js'), 0o755);
  publishStagingDist();
} catch (error) {
  rmSync(stagingDist, { recursive: true, force: true });
  throw error;
}
