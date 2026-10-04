# 当前会话执行器、模型与速度

Codex App 承载的 Botmux 会话可在 Codex 与 TraeX 的 app-server 之间切换，不改全局配置，也不需要新建飞书话题或 Team。`codex` 是 `codex-app` 的命令别名；原生 TUI 会话暂不经此入口转换。

```sh
botmux model list
botmux model list --executor traex
botmux model set gpt-6-astra xhigh --executor traex --speed default
botmux model executor codex-app
botmux model effort high
botmux model speed priority
botmux model hooks always
botmux model status
```

默认从当前进程所属会话定位；从普通终端操作时加 `--session-id <完整会话ID>`。
模型、推理等级和服务档位均按目标执行器的实时 `model/list` 校验；TraeX 的显示名称映射到目录明确提供的 `configName`。`--service-tier` 与 `--speed` 等价。`default` 用于恢复默认服务档位；`priority` 仅在目录明确支持时允许。跨执行器默认恢复 `default`，不继承另一服务的 priority。执行器缺失、未登录或能力不支持时明确失败。

`hooks always` 是用户对本会话的持续授权：保持所有已启用 Hooks，通过底层线程的 `bypass_hook_trust` 接受执行，模型或执行器切换后继续保留。默认策略为 `review`，未获得授权的会话不会自动同意。只改信任策略时恢复同一底层线程，不丢失历史；用 `botmux model hooks review` 撤销持续授权。

已发出的推理请求继续使用原配置。下一轮，包括自动继续，读取最新会话设置，通过 `turn/start` 应用模型、推理等级和服务档位。同执行器内保留底层线程；跨执行器新建目标线程，迁移最近最多 24 条、约 24000 字符的可见用户/助手对话，不复制隐藏推理及工具输出。旧线程保留，飞书会话 ID 不变。更早历史可通过 `botmux history` 回查。目标初始化失败时保留原线程，当前请求报错，不悄悄使用旧执行器继续。

切换命令返回成功仅代表设置已保存；`status` 的 `accepted` 表示 app-server 接受请求，`verified` 表示该配置下的推理已成功完成，`failed` 表示该轮失败。运行回执包含实际执行器、底层线程、模型、推理等级和速度档位。旧回执、旧修订和退出的进程不能冒充当前配置已生效。

首次给旧版运行器启用此能力时，仅目标会话等当前请求结束、安全空闲后更新运行器。后续切换直接读取新设置，无需重启。daemon 部署仍保留其他持久 AI 进程。被观察的外部终端、不属于该 bot 的会话、已停用会话以及非 Codex App 会话不能由此入口修改。

数据写入 `<session-data>/session-models/`，每会话独立原子文件保存期望配置、运行回执及执行器恢复位置，目录/文件权限为 0700/0600。待迁移的可见对话暂存至新线程接收请求后清除，不保存凭据或修改全局配置。

IPC：`GET /api/sessions/:id/model`、`GET /api/sessions/:id/model/list?executor=traex`、`POST /api/sessions/:id/model`。POST 正文只接受 `executor`、`model`、`effort`、`serviceTier`、`hookTrust`。
