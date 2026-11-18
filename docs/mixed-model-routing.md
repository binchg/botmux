# 单机器人混合模型路由

机器人通过 `env.MIXED_MODEL_ROUTES_FILE` 显式启用。没有配置时，原有 Codex、TraeX 默认和单向接续行为保持原样。配置仅写目标机器人，不修改全局 Codex 配置，不给其它机器人注入环境。

目录中的每项绑定真实的执行器、模型或接入点和推理档位。`automatic:false` 只开放手动选择，不参与自动排序，可用于尚未实测的目录候选。例如：

```json
{
  "version": 1,
  "maxAttempts": 3,
  "cooldownMs": 120000,
  "routes": [
    {"executor":"traex","model":"gpt-6-astra","policyModel":"gpt-6-astra","effort":"xhigh"},
    {"executor":"codex-app","model":"gpt-6.1-sol","policyModel":"gpt-6.1-sol","effort":"xhigh"},
    {"executor":"ark","model":"ep-example","policyModel":"gpt-6-astra","effort":"xhigh","displayName":"GPT-6-Astra"}
  ]
}
```

`policyModel` 保留原 TraeX 能力顺序。目录中的真实空闲 TraeX 优先，繁忙候选后置；其它通道的负载未知，只能通过请求确认准入。首 token 实测只在同档候选间作小幅排序，不能覆盖能力顺序。队列、额度和限流失败使该通道模型进入冷却，每轮最多尝试配置上限个不同候选。下个用户请求才重新考虑冷却已到期的候选。

方舟还要求 `ARK_CODEX_HOME` 指向独立配置目录，`ARK_MODELS_FILE` 指向已核验的模型清单；禁止复用全局目录及其软链接。方舟子进程使用该目录，原生 Codex 和 TraeX 继续使用原环境。密钥由所选提供方的标准认证或本地认证命令提供，不放进路由 JSON、仓库、日志或普通消息。接入点与底层模型的映射必须来自平台回读，公共模型目录不能直接当作已授权接入点。

工具网关使用独立的 `gateway` 执行器、`GATEWAY_CODEX_HOME` 和 `GATEWAY_MODELS_FILE`。将需经网关计量的型号放入 `gatewayOnlyModels`，自动候选及旧的固定设置都会遵守该限制。网关授权未就绪时，这些型号保持不可用。其它能力可通过 `modelOrder` 完整指定排序，未配置时沿用 TraeX 原顺序。

方舟清单示例：

```json
[
  {"model":"ep-example","displayName":"GPT-6-Astra","defaultReasoningEffort":"xhigh","supportedReasoningEfforts":[{"reasoningEffort":"xhigh"}]}
]
```

`MIXED_MODEL_HEALTH_FILE` 指定目标机器人的健康摘要文件；多个会话带锁合并数值观测，不保存对话和凭据。`botmux model list --session-id <id>` 返回带通道的唯一标识；`botmux model route --mixed --session-id <id>` 回读实际排序、冷却、首 token 和耗时。模型卡片同样使用带通道的标识，固定选模优先于自动路由。

TraeX 排队只接受当前线程与进程的实际队列事件：短队列最多等 10 秒，长队列或额度低优先级直接降级。其它通道的无活动期限为 60 秒，确认中断后才能重选；无活动不能被称为排队。出现工具执行、正文输出、用户取消或并发选模后，不自动重放。切换通道时迁移最近可见文本，较早历史和工具结果不能假称完整迁移。

真实自测使用 `node --import tsx scripts/verify-mixed-models.ts --allow-model --executor <codex-app|traex|ark|gateway> --model <真实模型或接入点>`；`--source` 验源码，其余验证已构建运行器。`--mixed` 使用当前进程显式配置的混合目录。测试在独立目录验证相同的输出、排程推理、工具读取、追问和代码产物，代码由独立断言判分。只有实际 assistant delta 才计首 token，完整耗时另列；未获得后端身份字段时保持 `backendIdentityVerified=false`，小样本答题不能代表通用智力排名。

部署通过 canonical `dev` 的 `deploy:dev -- --bot <准确 AppID>`，发布后只重载该机器人持久运行器，并回读非目标 PID、配置与全局 Codex 指纹。方舟尚未授权或未经实测的候选应保持未启用。
