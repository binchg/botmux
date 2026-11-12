# TraeX 动态模型与成对机器人共享上下文

使用 `codex-app` 协议桥接 TraeX，可保留 Botmux 的进度转发、追问和模型运行回执。
在目标机器人的 `env` 中设置以下内容，仅对该机器人的新运行器生效：

```json
{
  "TRAEX_ADAPTIVE_MODELS": "gpt-6-astra,gpt-6.1-sol,gpt-6.1-terra,gpt-5.6-sol,gpt-5.6-terra,gpt-6-sol,gpt-5.6-luna,gpt-6-luna,gpt-5.5,gpt-5.4,gpt-5.2",
  "TRAEX_ADAPTIVE_COOLDOWN_MS": "120000",
  "TRAEX_ADAPTIVE_QUOTA_RESET_HOUR": "6",
  "BOT_SHARED_CONTEXT_GROUP": "paired-bots",
  "BOT_SHARED_MEMORY_DIR": "/absolute/path/to/memories"
}
```

`TRAEX_ADAPTIVE_MODELS` 按模型偏好从高到低排列。TraeX app-server 会话默认使用上述图片参考顺序和 `xhigh`，旧型号保留为后备。列表最多16项；目录缺失的6.1-Terra、6-Sol、6-Luna只保留排名，不调用或替换成其它型号；`TRAEX_ADAPTIVE_ENABLED=0` 关闭自动选择。Codex 执行器不受影响。显式推理等级仍优先。

启动及每次新轮次通过 `traex debug models --remote` 刷新目录。仅请求负载已知且低于100%、支持推理等级、无已报告排队且额度未明确耗尽的模型；在准入候选之间综合能力顺序、明确的剩余额度和负载压力。缺失额度如实标为未知，不冒充有额度；实际请求得到的额度耗尽错误会把该模型避开至下一次本地 `06:00`（可用 `TRAEX_ADAPTIVE_QUOTA_RESET_HOUR` 调整）。

当前 TraeX 进程（含 Hook 包装器后的真实 app-server）、当前线程、最近一次进度之后的实际排队日志会触发冷却、中断和重选；目录指标不等于不排队保证。同一用户请求最多尝试三个不同模型，刷新和冷却到期均不清空已尝试集合。实际排队后，可准入候选均已尝试便立即结束准入，不为了超载或负载未知的型号额外等待。尚未请求就暂时繁忙或目录失败时，每15秒刷新，每次准入等待最多两分钟，到期输出明确失败终态。只有新的用户请求才重新建立尝试集合，不自动循环下一轮。等待仍可取消。

跨执行器接续默认关闭。用户允许时，可在该机器人的 `env` 配置 `TRAEX_ADAPTIVE_FALLBACK_EXECUTOR=codex-app`、`TRAEX_ADAPTIVE_FALLBACK_MODEL=<本机 Codex 支持的型号>` 和 `TRAEX_ADAPTIVE_FALLBACK_EFFORT=xhigh`。仅 TraeX 准入耗尽或超时触发一次切换；先校验目标模型能力，目标初始化成功后才替换底层线程，迁移最近可见对话并保留原请求。更早历史和工具结果需要回查，不能声称完整线程迁移。用户取消、Hook 失败、配置并发变更都不触发接续；目标失败直接报错。切换后持久使用 Codex，只有用户显式选择 TraeX 才切回，避免执行器间循环。不修改 Codex 全局模型配置。

切换保留原线程、追问和工具结果；工具执行期间不切换，用户取消、关键 Hook 失败和正常完成赢得中断竞争时不自动续跑。忙时追问保留在当前轮，健康生成不会只为升级而被打断。下一条新轮次重新选择最高档候选，运行回执记录实际模型。

标准新建 TraeX 话题使用 app-server；已有 app-server 会话恢复后继续生效。接管模式、额外 wrapper 和尚未迁移的旧原生终端保持原样，避免把控制消息写进不兼容的 TUI。

`botmux model route --json` 查询目录、顺序和预选候选；`queueAdmissionVerified=false` 表示该只读查询未发出推理请求。`kmp-cli scan --rule traex-model-routing --json` 复用同一入口；指定会话用 `review` 查看运行回执，`sync --session-id <id> --apply` 启用 TraeX/xhigh 并在下一轮生效。

## 回复与 Web 终端的实际模型展示

TraeX 正常标签为 `TraeX · GPT-6.1-Sol · xhigh · 负载 86%`，不加“模型：”、运行中或 botmux 品牌页脚。每个新用户轮次和忙时追问仅前两条及最后一条回复显示；中间消息不显示。daemon 在内部/重复/终态抑制之后与显式 `botmux send` 共用加锁预算，自动重选和429继续不重置。显式最后一条用 `--terminal`，既显示模型也阻止后续自动兜底。标识沿用冻结的实际模型，不写入线程上下文；机器结果 JSON 保持原样。

Web 终端顶部在打开时读取运行回执，并每 2 秒刷新；重连及重新可见时也刷新。正常状态使用相同简洁标签；选模和等待仍显示“尚未选定模型”，实际排队、失败和停止状态不隐藏。`负载`仍是请求前快照，不冒充实时负载或无排队保证。显示接口沿用终端鉴权，不返回线程正文、PID、路径或凭据。

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
