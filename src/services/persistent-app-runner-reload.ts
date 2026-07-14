const BOTMUX_APP_RUNNER_CLI_IDS = new Set(['codex-app', 'mira', 'mir']);

/** Botmux-owned app runners execute JavaScript from dist inside the persistent
 * terminal process. Reattaching that process after a daemon deployment keeps
 * its old in-memory code, so it must be replaced once the current turn reaches
 * idle. Third-party CLIs are not Botmux code and must stay attached. */
export function shouldReloadPersistentAppRunner(
  cliId: string | undefined,
  willReattachPersistent: boolean,
): boolean {
  return willReattachPersistent && BOTMUX_APP_RUNNER_CLI_IDS.has(cliId ?? '');
}
