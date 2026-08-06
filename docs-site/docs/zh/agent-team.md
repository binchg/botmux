# 同 Bot Agent Team

Agent Team 让一个 Botmux 会话只做 supervisor，同一个飞书 Bot 在同一群里创建多个持久、独立、可见的 Codex App 会话并行工作。

## 运行模型

- leader 是现有 Botmux session，只做拆分、派活、观察、追问、中断、验收和回收。
- `spawn` 先持久登记 worker。`depends-on` 未满足时保持 `queued` 且不创建 session；依赖当前 attempt 全部 `succeeded` 后才事件驱动启动。
- worker 只得到团队目标与自己的任务边界，不复制 leader 的完整对话，也不创建 sub-agent。
- worker 的过程消息留在自己的飞书话题；通过窄结构化 schema 的当前 attempt final 才进入持久 outbox 并幂等注入 leader。
- Team 注册表与 session 分开持久化。daemon 重启后关系仍可查询，运行状态则实时读取 worker/session。

## 快速使用

这些命令由 leader 会话里的 agent 调用，session 和 daemon 会自动推断：

```bash
botmux team create \
  --name "Alpha 提取" \
  --objective "审查候选改动，按依赖拆分，合格项验证后交付" \
  --max-active-workers 3

botmux team spawn \
  --id review-contract \
  --title "契约与依赖审查" \
  --repo /path/to/repo \
  --reuse-key alpha-contract-review \
  --assignment "只审查契约和依赖，给出证据、风险和候选文件，不改代码"

botmux team status
botmux team send --worker review-contract --kind correction --lifetime task-scoped \
  --content "新证据已到，作废旧 SHA 后重查"
botmux team milestone --team <team_id> --type bits_mr_ready \
  --summary "BITS MR 已创建" --url "https://bits.example/mr/123" --evidence-ref "sha:abc123"
botmux team interrupt --worker review-contract
botmux team reap
```

不传 `--team` 时，命令使用当前 leader 最近更新的 active Team。完整参数见 `botmux team help`。

## 控制语义

| 动作 | 语义 |
|------|------|
| `status` | 合并 revision/attempt、outbox、session、worker、指标和 leader-wide 容量 |
| `spawn` | 默认最多 3 个活跃 worker、硬上限 4；queued 不占配额。相同 `reuse-key` 或同目录 writer 返回复用指引，不重复创建 |
| `send` | 追加 correction/replacement/addition revision 和新 attempt；active/idle runner 直接发送，runner 缺失才 refork，只有 session 已 closed 才 resume，始终保持原 team/worker/session/thread 坐标。`status_query` 只读且不创建 attempt |
| `milestone` | 持久记录 `audit_eligible`、`commit_pushed`、`bits_mr_ready`、`build_started`、`build_terminal` 非终态事件。BITS URL 立即投递 leader 话题并 @ 提出者；旧 revision 隔离，重复 URL 幂等 |
| `interrupt` | 先进入 `interrupting`；只有 Codex App Server 回执后才进入 `interrupted` |
| `reap` | 只关闭结构化终态或已确认中断的 worker，不回收 queued/running/interrupting |

最终结果最少包含 `attemptId`、`revisionId`、`status`、`summary`、`evidenceRefs`、`metrics`。旧 revision、重复或不合法 final 会被隔离，不能放行依赖。report 使用稳定 `reportId`，daemon 重启后从持久 outbox reconciliation。

milestone 不会提前终结 attempt。状态同时暴露 `guidanceToFirstArtifactMs`、`guidanceToBitsUrlMs`、`bitsUrlToBuildTerminalMs`；已授权的低风险写入任务在机器审计通过后默认继续 write→push→BITS，并让人工 review 与 RemoteX 并行，只有 ref 漂移、范围扩大、高风险或外部权限才暂停。

推荐先并行派只读审查，再根据依赖和证据串行开放写入任务。用户的新纠偏如果使分支、SHA、MR 或构建参数失效，leader 应立即打断相关 worker，并用新基线重新派活。
