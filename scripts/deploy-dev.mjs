#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpPatchVersion, readVersionPayload } from './lib/dev-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionPath = join(repoRoot, 'dev-version.json');
const expectedBranch = process.env.BOTMUX_DEPLOY_BRANCH || 'dev';
const expectedCanonical = resolve(process.env.BOTMUX_CANONICAL_DIR || '/home/chenjinbin.i/workspace/d/botmux');
const requiredRemote = /github\.com(?::|\/)binchg\/botmux(?:\.git)?$/;
const sensitivePath = /(^|\/)(?:\.env(?:\.|$)|bots\.json$|id_(?:rsa|ed25519)$|[^/]+\.(?:pem|key|p12|pfx)$)/i;

function run(bin, args, capture = false) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${bin} ${args.join(' ')} 失败（${result.status ?? 'spawn'}）${detail}`);
  }
  return capture ? String(result.stdout || '').trim() : '';
}

function git(args, capture = true) {
  return run('git', args, capture);
}

function parseArgs(argv) {
  let message = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--message' || argv[i] === '-m') message = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: corepack pnpm deploy:dev -- --message "fix(scope): 中文描述"');
      process.exit(0);
    } else if (argv[i] !== '--') throw new Error(`未知参数: ${argv[i]}`);
  }
  if (!message.trim()) throw new Error('必须通过 --message 提供本次提交说明');
  if (/[\r\n]/.test(message)) throw new Error('--message 只允许单行提交标题');
  return { message: message.trim() };
}

function assertCanonicalCheckout() {
  if (realpathSync(repoRoot) !== realpathSync(expectedCanonical)) {
    throw new Error(`只允许从 canonical checkout 部署: ${expectedCanonical}`);
  }
  const branch = git(['branch', '--show-current']);
  if (branch !== expectedBranch) throw new Error(`只允许部署 ${expectedBranch} 分支，当前为 ${branch || 'detached'}`);
  const remote = git(['remote', 'get-url', '--push', 'origin']);
  if (!requiredRemote.test(remote)) throw new Error(`origin 不是用户 canonical GitHub 仓: ${remote}`);
}

function assertNoSensitiveChanges() {
  const names = new Set([
    ...git(['diff', '--name-only']).split('\n'),
    ...git(['diff', '--cached', '--name-only']).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean));
  const blocked = [...names].filter(name => sensitivePath.test(name));
  if (blocked.length) throw new Error(`拒绝自动提交敏感路径: ${blocked.join(', ')}`);
}

function assertNotBehindRemote() {
  git(['fetch', 'origin', expectedBranch], false);
  const counts = git(['rev-list', '--left-right', '--count', `HEAD...origin/${expectedBranch}`])
    .split(/\s+/).map(Number);
  const ahead = counts[0];
  const behind = counts[1];
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) throw new Error('无法判断本地/远程提交关系');
  if (behind > 0) throw new Error(`本地落后 origin/${expectedBranch} ${behind} 个提交，请先安全同步`);
}

function bumpVersion() {
  const current = readVersionPayload(readFileSync(versionPath, 'utf8')).version;
  const next = bumpPatchVersion(current);
  writeFileSync(versionPath, `${JSON.stringify({ version: next }, null, 2)}\n`);
  return { current, next };
}

function verifyRemoteHead(localHead) {
  const output = git(['ls-remote', 'origin', `refs/heads/${expectedBranch}`]);
  const remoteHead = output.split(/\s+/)[0] || '';
  if (remoteHead !== localHead) throw new Error(`push 回读不一致: local=${localHead} remote=${remoteHead || 'missing'}`);
}

function main() {
  const { message } = parseArgs(process.argv.slice(2));
  assertCanonicalCheckout();
  assertNoSensitiveChanges();
  assertNotBehindRemote();
  const { current, next } = bumpVersion();

  run('corepack', ['pnpm', 'exec', 'vitest', 'run', '--project', 'unit',
    'test/dev-deploy-version.test.ts', 'test/install-info.test.ts',
    'test/restart-report.test.ts', 'test/codex-app-progress.test.ts',
    'test/persistent-app-runner-reload.test.ts', 'test/session-lifecycle-hooks.test.ts',
    'test/codex-app-hook-health.test.ts', 'test/codex-app-runner.test.ts',
    'test/codex-app-thread-title.test.ts', 'test/cli-adapters.test.ts',
    'test/agent-team-store.test.ts', 'test/agent-team-human-output.test.ts',
    'test/agent-team-command.test.ts', 'test/build-atomic.test.ts']);
  run('corepack', ['pnpm', 'build']);

  git(['add', '-A'], false);
  git(['diff', '--cached', '--check'], false);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) throw new Error('没有可提交改动');
  git(['commit', '-m', message, '-m', `Dev-Version: v${next}`], false);
  const head = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', `HEAD:${expectedBranch}`], false);
  verifyRemoteHead(head);

  // 只有远程回读已包含当前 HEAD 后，才能改变 live 运行态。
  run('corepack', ['pnpm', 'use:here']);
  run('corepack', ['pnpm', 'daemon:restart']);
  const runtimeVersion = execFileSync(process.execPath, [join(repoRoot, 'dist', 'cli.js'), '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().replace(/^v/, '');
  if (runtimeVersion !== next) throw new Error(`运行时版本回读失败: expected=${next} actual=${runtimeVersion}`);

  console.log(JSON.stringify({
    ok: true,
    version: { previous: current, current: next },
    commit: head,
    remote: `origin/${expectedBranch}`,
    pushVerified: true,
    deployedAfterPush: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`deploy-dev: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
