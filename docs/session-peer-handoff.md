# 平级会话交接与停用

两个同 bot、同 owner 的独立话题可以交接任务。交出方与接手方是平级会话，
交接不建立 leader/sub-agent 关系，也不要求已有 Team。

```sh
botmux team handoff --to <接手会话ID> --session-id <交出会话ID>
```

`team` 只是兼容现有 CLI 的命令入口；实际请求为
`POST /api/sessions/:sessionId/handoff`，正文只有 `targetSessionId`。
该调用会关闭交出方的 runner，应在交接内容已保存且接手会话确认可用后执行。
接手会话保持运行，不复制正文、工作目录或其它任务身份。

停用账本先于 runner 关闭写入。交出话题的进度、终态、人工处理通知、流卡更新、
降级回复和迟到补发在发送前读取同一事实，不再回传到交出话题。已经排队的回复
保留为 `suppressed`，不删除历史、不生成新告警，也不自动改投接手话题。
已经发出的请求不会被撤回。

旧 Team 的唯一接手会话在交接时解除编排角色。Team 的历史 revision、attempt
及 outbox 保留；当前 turn 自然结束时只向接手话题显示校验后的摘要。
daemon 重启或旧进程回写 `active` 都不能撤销交接事实。

当前支持独立的 thread scope。相同话题、chat scope、不同 bot/owner、已停用的
接手会话会被拒绝。旧会话还有其它活跃 Team 任务时拒绝交接，避免遗失其编排。
请求在同一接手目标上幂等；更换目标或交给已经停用的会话需另行处理。
