/**
 * 生成 PM2 daemon 的固定机器人编号参数。
 *
 * 编号必须进入进程参数而不是只依赖环境变量，避免运维执行
 * `pm2 reload --update-env` 时把当前会话的编号覆盖到全部实例。
 */
export function daemonBotIndexArgs(index: number): string[] {
  return ['--bot-index', String(index)];
}

/**
 * 解析 daemon 应使用的机器人编号。
 *
 * 固定进程参数优先；环境变量仅用于兼容旧版 ecosystem 配置和直接启动方式。
 * 参数存在但缺值或格式非法时返回 `NaN`，交给 daemon 的既有配置校验明确失败。
 */
export function resolveDaemonBotIndex(
  argv: string[],
  envValue: string | undefined,
): number | undefined {
  let argPresent = false;
  let rawArg: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bot-index') {
      argPresent = true;
      rawArg = argv[i + 1];
      break;
    }
    if (arg.startsWith('--bot-index=')) {
      argPresent = true;
      rawArg = arg.slice('--bot-index='.length);
      break;
    }
  }

  const raw = argPresent ? rawArg : envValue;
  if (raw === undefined) return argPresent ? Number.NaN : undefined;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  return Number.parseInt(raw, 10);
}
