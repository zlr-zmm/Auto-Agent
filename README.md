# Auto-Agent

**飞书驱动的个人自主智能体**：在飞书群里 @机器人 提需求，它自己澄清、拆解、建 issue、写代码、开 PR——你只在两件事上出现：**点确认卡片**，**merge PR**。

```
你（飞书群 @机器人）
   ▼
superagent.mjs ────── 确定性层（零依赖 Node ≥20）
   轮询 → 门禁（open_id 名单 + @检测 + 防循环 + 回复延续）
   工单 ↔ 多维表格双向同步（9 态状态机，Outbox 先存后做、幂等可重放）
   每 task 一个 git worktree 隔离工作区 → commit/push/gh pr create → 状态回写
   ▼
agent-autoloop ────── 常驻内核（调度：排队/合并/会话续接/token 统计）
   feishu-watch.ts 每 2 分钟轮询（零 token）；只有 queued 工单才触发 LLM 轮次
   ▼
任意无头 CLI Agent ── 判断层（默认 codex；SKILL.md 是 PM 的头脑）
   回执协议：ask（飞书按钮卡片）/ later（定时复查）/ notice
   等你拍板时不占进程、不烧 token；你点卡片即唤醒续跑
   ▼
GitHub PR（人 merge）+ 飞书多维表格（你的工单面板）
```

## 为什么这样设计

继承 DeepSeek superagent 模式（[deepseek-superagent-guide](https://github.com/switch-dimension/deepseek-superagent-guide)）的四个原则，并用 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 做常驻内核：

1. **授权是代码不是提示词**——门禁在脚本里确定性执行，消息内容永远无法授予许可
2. **先存储后动作**——所有外部写入走 Outbox，崩溃不重不漏
3. **一轮不等人**——需要拍板就结束本轮发卡片，等待零成本
4. **人 merge**——agent 永不合并自己的 PR

## 组件

| 文件 | 职责 |
|---|---|
| `superagent.mjs` | 全部确定性 I/O：`poll` / `send` / `issues` / `ticket` / `prs check` / `state` / `outbox` |
| `feishu-watch.ts` | agent-autoloop 事件源：消息→事件；drive 只在 queued 工单时发（防 LLM 轮次空转）；PR 回写确定性直做 |
| `SKILL.md` | PM Agent 的提示词（装到 Agent 的 skills 目录，如 `~/.codex/skills/auto-agent/`） |
| `config.example.json` | 配置模板（真实 config.json 含本机标识，已 gitignore） |

## 从零搭建

### 1. 飞书侧

1. [开放平台](https://open.feishu.cn)建企业自建应用，开通**机器人**能力
2. 装 [lark-cli](https://github.com/larksuite/cli)（≥1.0.90），给机器人建**独立配置目录**并锁纯机器人身份：
   ```sh
   LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-autoagent lark-cli config init --app-id cli_xxx --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-autoagent lark-cli config strict-mode bot --global
   ```
3. 申请权限（走 scope-apply 页一键开通最快）：`im:message`、`im:message:send_as_bot`、`im:chat*`、`im:resource`、`bitable:app`、`base:app*`（table/field/record 全套）、`drive:drive`、`space:folder:create`，以及卡片回调 `card.action.trigger`（lark-cli 报错时会给出订阅直达链接）
4. 建多维表格「工单」表，字段：标题/类型(epic,task)/状态(待澄清,待确认,已拆解,进行中,待验收,已提交,已合并,已拒绝,已取消)/优先级/负责角色/验收标准/拆解说明/父需求/依赖/工单ID/来源消息/PR链接

### 2. 内核与 Agent

1. 装 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)，`rules.json` 两条规则：
   - `飞书轮询`：cron `*/2 * * * *` → watcher（本仓库 feishu-watch.ts），`tell: never`
   - `PM处理`：source feishu 的 `feishu.message`/`loop.drive` → 你的 Agent（codex 建议 `access: full`，否则沙箱断网读不了 gh），`skill: auto-agent`，`parallel: 1`
2. 飞书通道：config.json 的 `channels.feishu` 填 `{ "use": "feishu", "key": <key new channel cards>, "user": <你的 open_id> }`
3. 复制 config.example.json → config.json 填齐；把 SKILL.md 装进 Agent 的 skills 目录

### 3. 已知的坑（都踩过）

- **Git Bash/MSYS**：`/open-apis/...` 参数会被改写成 Windows 路径（`MSYS_NO_PATHCONV=1`）；环境变量给原生 exe 要用 `C:/` 风格
- **Git 凭据**：Windows 凭据管理器的旧 token 会遮住 gh 的（仓库本地 `git config credential.helper ""` 再 add gh helper）
- **codex 沙箱**：`workspace-write` 默认断网，gh/git push 会失败——规则里给 `access: full`
- **`node --test test/`** 在 Windows 会误报，用 `node --test "test/*.test.js"`
- 中台进程要继承 `LARKSUITE_CLI_CONFIG_DIR`（`setx` 后重启中台）

## 使用

群内 `@机器人 <需求>` → PM 澄清（一次一问）→ 拆解方案卡片 → 点「确认执行」→ 表格出 issue、worktree 开工、PR 落地 → merge 后表格自动「已合并」、epic 自动收口。说「进度」随时查状态。

## License

MIT
