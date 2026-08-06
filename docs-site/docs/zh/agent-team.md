# 同 Bot Agent Team

Agent Team 让一个 Botmux 会话只做 supervisor，同一个飞书 Bot 在同一群里创建多个持久、独立、可见的 Codex App 会话并行工作。

## 运行模型

- leader 是现有 Botmux session，只做拆分、派活、观察、追问、中断、验收和回收。
- 每次 `spawn` 都发一条顶层话题种子，并直接创建独立 thread session；Bot 不需要通过 @ 自己来唤醒自己。
- worker 只得到团队目标与自己的任务边界，不复制 leader 的完整对话，也不创建 sub-agent。
- worker 的过程消息留在自己的飞书话题；最终回复持久化后自动注入 leader。
- Team 注册表与 session 分开持久化。daemon 重启后关系仍可查询，运行状态则实时读取 worker/session。

## 快速使用

这些命令由 leader 会话里的 agent 调用，session 和 daemon 会自动推断：

```bash
botmux team create \
  --name "Alpha 提取" \
  --objective "审查候选改动，按依赖拆分，合格项验证后交付"

botmux team spawn \
  --id review-contract \
  --title "契约与依赖审查" \
  --repo /path/to/repo \
  --assignment "只审查契约和依赖，给出证据、风险和候选文件，不改代码"

botmux team status
botmux team send --worker review-contract --content "新证据已到，作废旧 SHA 后重查"
botmux team interrupt --worker review-contract
botmux team reap
```

不传 `--team` 时，命令使用当前 leader 最近更新的 active Team。完整参数见 `botmux team help`。

## 控制语义

| 动作 | 语义 |
|------|------|
| `status` | 合并持久任务状态、session 状态、worker 存活状态与最近事件 |
| `send` | 在 worker 话题留下可见的 leader 指令，并 steer 到同一 Codex App thread |
| `interrupt` | 调用 Codex App Server 的 `turn/interrupt`；保留 thread 和上下文 |
| `reap` | 只关闭已回报、中断或失败的 worker，不误杀仍在工作的会话 |

推荐先并行派只读审查，再根据依赖和证据串行开放写入任务。用户的新纠偏如果使分支、SHA、MR 或构建参数失效，leader 应立即打断相关 worker，并用新基线重新派活。
