# TraeX 动态模型与成对机器人共享上下文

使用 `codex-app` 协议桥接 TraeX，可保留 Botmux 的进度转发、追问和模型运行回执。
在目标机器人的 `env` 中设置以下内容，仅对该机器人的新运行器生效：

```json
{
  "TRAEX_ADAPTIVE_MODELS": "gpt-6-astra,gpt-6.1-sol,gpt-5.6-sol",
  "TRAEX_ADAPTIVE_COOLDOWN_MS": "120000",
  "BOT_SHARED_CONTEXT_GROUP": "paired-bots",
  "BOT_SHARED_MEMORY_DIR": "/absolute/path/to/memories"
}
```

`TRAEX_ADAPTIVE_MODELS` 从高到低排列。未设置时保留原有行为。开启后，新运行器默认使用
TraeX，推理等级默认 `xhigh`；已保存的执行器选择和手动切换仍然有效。

每次新请求优先选择目录中可用且不在冷却期的最高档模型。只有当前 TraeX 进程、当前线程、
最近一次进度之后的 `request_wait_in_queue` 日志会触发降级。目录负载百分比、长推理和
静默不会被当作排队。运行器每秒检查，并在 Hook / 追问到达时检查。

确认排队后，先标记该模型冷却，再中断等待，沿原线程发送继续指令。已完成工具操作和追问
保留在原线程，每条用户请求最多向下遍历一次模型列表。到最低档继续等待，并只提示一次。
工具执行期间不切换；用户取消、关键 Hook 失败或正常完成赢得中断竞争时，不自动续跑。
冷却结束后的下一条请求会重新尝试高档模型，不打断正常生成来升级。运行回执记录实际选中模型。

共享组中每个机器人的 `env` 设置相同 `BOT_SHARED_CONTEXT_GROUP` 和记忆路径，同时在
`SESSION_DATA_DIR/shared-bot-context/<group>/members.json` 写入明确的 App ID 数组：

```json
["cli_first", "cli_second"]
```

共享组目录权限应为 `0700`，成员文件为 `0600`。新请求和忙时追问读取共享快照：

- 同群、同话题、同工作目录的另一机器人：可见用户消息、阶段进度、最终回复、运行状态。
- 同一 ownerUnionId 的其它话题：只提供会话索引，可按用户要求用 `botmux history --session-id` 回查。
- 不读取第三个机器人，不拼接隐藏推理、工具输出或开发者指令，不共享原生线程写入权。
- 长期记忆使用同一个目录。沿用只在用户明确要求时追加更新记录的约定；凭证、身份和金融明细不写入记忆。

旧会话在运行器恢复后生效。已有未入组的会话不会自动获得共享访问。共享目录缺失或损坏时，
不注入上下文并记录原因。目录和会话索引保留，原始历史无需迁移或改写。

验证命令：

```bash
corepack pnpm exec vitest run --project unit test/traex-adaptive-model.test.ts test/shared-bot-context.test.ts test/session-model.test.ts test/codex-app-runner.test.ts
corepack pnpm exec tsc --noEmit
```
