# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini 等 20+ 种，完整列表见 README）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:restart       # 重启 daemon（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

- canonical `dev` 分支每次修改后部署必须使用
  `corepack pnpm deploy:dev -- --message "type(scope): 中文描述"`。该命令会把
  `dev-version.json` 尾号 +1，先测试/build、commit/push 并回读远程 HEAD，
  只有 push 成功后才认领 checkout 并 restart。禁止把未 push 代码直接部署到 live。

### 多 checkout：全局 `botmux` 指向谁

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 瘦 wrapper，指向「最后认领的 checkout」的 `dist/cli.js`（daemon 启动时也会写）：

本机部署有更严格的唯一源约束：live botmux 只能由用户自己的 canonical checkout `/home/chenjinbin.i/workspace/d/botmux` 当前个人分支和工作区代码认领并部署。`workspace/w/*`、task worktree、review checkout、临时分支、干净 `origin/master` 快照和 npm 安装目录都不得认领全局 shim 或重启 live daemon；这些 checkout 构建时必须使用 `BOTMUX_NO_CLAIM=1`，只做测试。其它 checkout 的功能要上线时，先安全集成回 canonical checkout，再从 canonical 执行部署。部署前后必须分别核对 canonical 分支/HEAD/工作区 diff，以及全局 wrapper、daemon、worker 的真实路径，不能只看 build 成功。

```bash
pnpm use:here             # 把全局 botmux 指向当前 checkout（仅改指向，不重启 daemon）
pnpm switch:here          # = build + use:here 一步到位
BOTMUX_NO_CLAIM=1 pnpm use:here   # 逃生阀：本次不认领
```

纯 `pnpm build` 故意不认领——review/验证别人 PR 时不会悄悄抢走全局指向。实现见 `scripts/claim-botmux-bin.mjs`。

### 改动需用户手动测试时 → 先集成到 canonical，再部署 live daemon

当改动需要用户在飞书里**手动验证**（而非纯单测能覆盖），先把改动集成到 `/home/chenjinbin.i/workspace/d/botmux`，然后执行：

```bash
corepack pnpm deploy:dev -- --message "fix(scope): 中文描述"
```

否则用户测的还是旧代码（典型症状：新加的命令/配置「找不到」）。⚠️ 这会让**所有 bot** 都运行 canonical checkout 的当前 build；禁止为了临时验证把全局 shim 切到 review worktree，避免遗漏 canonical 未提交功能、worktree 删除后 shim 失效或运行源漂移。

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器，每种 CLI 一个文件（新增适配器的完整步骤见 `src/adapters/cli/CLAUDE.md`）
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `skills/` — 开箱即用的 Skill 定义 + installer
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## PR 规范

- 标题与 commit message 同格式：`type(scope): 中文描述`
- 描述用**中文说明**：改了什么、为什么、影响面（涉及哪些模块/会话类型）
- 附**实际测试验证**：贴出跑过的命令和关键结果（`pnpm build`、`pnpm test`、相关 e2e），不要只写「应该没问题」；需要 live 验证的使用 `deploy:dev` 在 push 后部署，再在飞书里实测并注明结果
- UI 类改动（飞书卡片 / dashboard / web 终端）附**截图示意**，让 reviewer 不用跑代码就能看到效果

## Git 提交 & 发版规范

- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文
- 日常 `git commit` + `git push` 不会触发发版；打 `v*` annotated tag 并 push 才发版（**仅在用户明确要求时**），CI 自动从 tag 提取版本号发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段；正式发版仍由 tag/CI 注入。canonical 源码部署版本单独记录在 `dev-version.json`，只允许 `deploy:dev` 自动尾号 +1，用于重启通知和 Git 回查。
- **正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`。非 master 分支灰度用 `-canary.N`/`-beta.N`/`-rc.N` 后缀（CI 自动路由到对应 npm dist-tag，其它 `-` 后缀兜底到 `next`，都不污染 latest）；验证 canary：`npm i -g botmux@canary`
