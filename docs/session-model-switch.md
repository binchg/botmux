# 当前会话模型与推理等级

Codex App 会话可以直接切换，不改全局 Codex 配置，也不需要新建话题或 Team。

```sh
botmux model list
botmux model set gpt-6-astra xhigh --service-tier priority
botmux model effort high
botmux model status
```

默认从当前进程所属会话定位；从普通终端操作时加 `--session-id <完整会话ID>`。
模型、推理等级和服务档位均按本机 app-server 的实时 `model/list` 校验，不把近似名称静默替换。

已发出的推理请求继续使用原配置。下一轮，包括自动继续，读取最新会话设置，并通过 `turn/start` 的 `model`、`effort`、`serviceTier` 应用。线程 ID 和历史保持不变。切换命令返回成功仅代表设置已保存；`status` 的 `accepted` 表示 app-server 接受请求，`verified` 表示该配置下的推理已成功完成，`failed` 表示该轮失败。旧回执、旧修订和退出的进程不能冒充当前配置已生效。

首次给旧版运行器启用此能力时，仅目标会话等当前请求结束、安全空闲后更新运行器。后续切换直接读取新设置，无需重启。daemon 部署仍保留其他持久 AI 进程。被观察的外部终端、不属于该 bot 的会话、已停用会话以及非 Codex App 会话不能由此入口修改。

数据写入 `<session-data>/session-models/`，每会话两个独立原子文件分别保存期望配置和运行回执，目录/文件权限为 0700/0600。不写入任务正文、账号凭证或全局配置。

IPC：`GET /api/sessions/:id/model`、`GET /api/sessions/:id/model/list`、`POST /api/sessions/:id/model`。POST 正文只接受 `model`、`effort`、`serviceTier`。
