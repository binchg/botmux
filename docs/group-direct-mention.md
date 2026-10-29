# 群消息仅直接 @ 响应

`group-direct-mention-policy.json` 位于 Botmux 运行数据目录，按应用 ID 保存布尔开关。
启用后，群中会话外的消息必须在当前文本或富文本正文中直接 @ 本机器人，才进入后续权限和会话路由。
群名片、合并转发、卡片、引用内部的 @、仅写机器人名字和 @所有人均不触发。

已绑定本机器人的会话话题内无需 @，包括独立话题和共享群会话的话题别名；仍需通过原访问权限。
仅有引用 root_id、未绑定话题或群里已有顶层会话，都不能让群顶层消息免 @。
明确 @ 其他成员的消息保持静默，当前消息同时直接 @ 本机器人时仍可处理。
此门禁优先于主人免 @、单人群免 @、自动开话题和 `ambient` 等策略；不改变私聊、
群会话复用方式或机器人之间的消息路由。
未设置的机器人沿用原行为。配置损坏时收紧为必须直接 @，写入拒绝覆盖损坏文件。

从已构建的 canonical checkout 设置指定机器人（替换示例应用 ID）：

```sh
node --input-type=module -e '
import { setDirectGroupMention, requiresDirectGroupMention } from "./dist/services/group-direct-mention-policy.js";
await setDirectGroupMention("cli_example", true);
console.log(requiresDirectGroupMention("cli_example"));
'
```

设置使用文件锁和原子写入，保留其它机器人的配置，下一条消息立即生效，无需重启。
设为 `false` 恢复原有策略。首次安装此能力仍需通过 `deploy:dev` 部署代码。

回归：`corepack pnpm exec vitest run --project unit test/group-direct-mention-policy.test.ts test/group-direct-mention-gate.test.ts test/event-dispatcher.test.ts`
