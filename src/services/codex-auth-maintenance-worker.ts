import { runCodexAuthMaintenanceOnce } from './codex-auth-maintenance.js';

// Launched under flock. This process never creates a thread, session, or model turn.
const [codexBin, cwd, authPath] = process.argv.slice(2);
if (!codexBin || !cwd || !authPath) {
  process.exitCode = 2;
} else {
  try {
    const decision = await runCodexAuthMaintenanceOnce(codexBin, cwd, authPath);
    process.stdout.write(JSON.stringify({ decision }) + '\n');
  } catch {
    // Credentials and upstream response bodies must not reach process logs.
    process.exitCode = 1;
  }
}
