# 普通群用户话题消息补发

用户在普通群的已有 Botmux 会话话题里追加消息时，可自动将原消息转发到同一个群。
飞书原生转发保留正文、图片和附件；发送身份是机器人，不会冒充用户发送。
这项功能与助手进度和最终结果的投递策略独立。

在 Botmux data 目录的 `user-thread-mirror-settings.json` 中配置 `targets` 数组。
每项包含准确的 `appId`、`chatId` 和 `userOpenId`；`chatId` 为 `*` 时，覆盖这个
机器人已经接入会话的所有普通群。没有配置时默认关闭；每次处理都会重新读取配置。

发送前重新查询真实群类型、原消息发送人、话题和群身份，以及飞书的
`sync_to_chat_info`。用户已经勾选“同时发送到群”时，不再补发。
话题群、私聊、机器人消息、未知会话以及回读失败都不发送。

按群与原消息 ID 原子认领，收据写入 `user-thread-mirror-receipts`，只记录身份和状态，
不保存正文。进程重启、多机器人竞争或消息重推都不会再次转发同一原消息。
平台请求使用同一个稳定 UUID。请求失败或结果未知时保留认领并记日志，不盲目重发，
原消息仍继续交给 AI 处理。

验证：`corepack pnpm exec vitest run --project unit test/thread-user-mirror.test.ts test/thread-sync.test.ts`。
上线后需回读真实图文消息及群副本；单测不替代飞书实际送达证据。
