# Same-Bot Agent Team

Agent Team turns one Botmux session into a supervisor while the same Lark bot creates multiple persistent, independent, visible Codex App sessions in the same chat.

## Runtime model

- The leader only decomposes, dispatches, observes, follows up, interrupts, verifies, and reaps work.
- Every `spawn` posts a top-level topic seed and directly creates an independent thread session. A bot does not need to mention itself.
- A worker receives only the team objective and its bounded assignment. It does not inherit the full leader transcript or create sub-agents.
- Worker progress stays visible in its topic. Its final response is persisted and automatically injected into the leader.
- Team relationships persist separately from sessions. Runtime status is read from the live session and worker.

## Commands

Run these from the leader's CLI session; Botmux infers the session and daemon:

```bash
botmux team create --name "Alpha extraction" --objective "Review and validate qualified changes"
botmux team spawn --id review-contract --title "Contract review" \
  --repo /path/to/repo --assignment "Review contracts and dependencies; do not edit code"
botmux team status
botmux team send --worker review-contract --content "Invalidate the old SHA and re-check the new baseline"
botmux team interrupt --worker review-contract
botmux team reap
```

Without `--team`, commands select the leader's most recently updated active team. `interrupt` uses Codex App Server `turn/interrupt` and preserves the thread. `reap` only closes workers that have reported, were interrupted, or failed.
