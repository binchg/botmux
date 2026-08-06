# Same-Bot Agent Team

Agent Team turns one Botmux session into a supervisor while the same Lark bot creates multiple persistent, independent, visible Codex App sessions in the same chat.

## Runtime model

- The leader only decomposes, dispatches, observes, follows up, interrupts, verifies, and reaps work.
- `spawn` first persists a worker. Unsatisfied `depends-on` workers remain `queued` without a session and start only after every dependency's current attempt succeeds.
- A worker receives only the team objective and its bounded assignment. It does not inherit the full leader transcript or create sub-agents.
- Worker progress stays visible in its topic. Only a schema-valid final for the current attempt enters the durable outbox and is idempotently injected into the leader.
- Team relationships persist separately from sessions. Runtime status is read from the live session and worker.

## Commands

Run these from the leader's CLI session; Botmux infers the session and daemon:

```bash
botmux team create --name "Alpha extraction" --objective "Review and validate qualified changes" --max-active-workers 3
botmux team spawn --id review-contract --title "Contract review" \
  --repo /path/to/repo --reuse-key alpha-contract-review \
  --assignment "Review contracts and dependencies; do not edit code"
botmux team status
botmux team send --worker review-contract --kind correction --lifetime task-scoped \
  --content "Invalidate the old SHA and re-check the new baseline"
botmux team interrupt --worker review-contract
botmux team reap
```

Without `--team`, commands select the leader's most recently updated active team. The default leader-wide limit is three active workers with a hard limit of four; queued workers do not consume capacity. Matching `--reuse-key`, or a writer in the same `--repo`, returns the reusable worker instead of spawning another session. `send` appends a revision/attempt and cold-resumes a closed worker with the original session/thread coordinates; `status_query` creates no attempt. `interrupt` stays `interrupting` until Codex App Server acknowledges it. Finals must include `attemptId`, `revisionId`, `status`, `summary`, `evidenceRefs`, and `metrics`; invalid or stale finals never release dependencies.
