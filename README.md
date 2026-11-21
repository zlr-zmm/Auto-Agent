# Auto-Agent

把飞书需求接进 [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop) 的 GitHub Issue 开发与交付流程。

```text
飞书提问 → 确认卡片 → GitHub Issue → 独立会话、分支和 worktree
         → PR + 验收证据 → Agent Autoloop 审查、CI、合并 → 飞书回写
```

## 上游与本仓库的分工

`vendor/agent-autoloop` 是指向上游提交 `f27466d` 的 Git 子模块。规则直接运行子模块的 `examples/recipes/github-issues/watch.ts` 和 `plugins/delivery/poll.ts`，用上游 Codex 和 `delivery` 插件执行。队列、事件去重、会话、卡片、审查与合并都由 Agent Autoloop 管理。

本仓库复用已有飞书门禁，提供需求整理、按 Issue 切 worktree、组装验收证据和结果回写。GitHub 的 Issue、PR 和检查是状态来源。 [流程和验收规范](docs/development-workflow.md)

## 接入

1. 在本仓库运行 `git submodule update --init`，使用 Node 24、Git、已登录的 Codex 和 `gh`。运行 Agent Autoloop 的 Worker；在飞书通道启用卡片回调，并配置允许回答的人。
2. 复制 `config.example.json` 为本机 `config.json`。填授权飞书用户、目标仓库与本地 `origin` 对应的 `repoPath`。在 Agent Autoloop 配置 `feishu-intake` 来源及来源密钥，并填 `workflow.hubUrl` 和 `workflow.feishuSourceKey`。Worker 数据目录非默认时填 `workflow.workerHome`。这些值留在本机。
3. 安装 `recipes/feishu-github/skills/` 里的两个 Skill。把 [规则示例](rules.workflow.example.json) 合入现有规则，替换路径、Worker 名和仓库名。保留飞书通道配置。运行 `node vendor/agent-autoloop/bin/agent-autoloop.ts check rules.workflow.example.json` 校验。切换时停掉同一会话的旧轮询规则。
4. 在目标仓库创建 `auto-agent-ready`、`auto-agent-working`、`auto-agent-waiting`、`auto-agent-pr`、`deliver`、`deliver-review` 标签。确认目标仓库 `main` 有 `ops/delivery.json` 和对应必需 CI，启用要求 PR 与最新目标分支兼容的分支保护。用独立交付 Worker 的 GitHub 身份执行审查和合并；这些配置就绪后启用本机 `workflow.autoDelivery`。保护路径始终走只审查。
5. 首次飞书轮询建立消息基线。随后 @机器人提需求，选择「确认执行」开始领单，或「仅建单」先记录。先用两个独立的小 Issue 核对并行、返工和回写。

自动交付沿用目标仓库自己的 CI。Auto-Agent 的 `check` 负责运行代码语法及上游规则校验。本地验证脚本放在忽略的 `work/` 里。

旧版多维表格命令仍保留，见 [旧版 SKILL](SKILL.md)。

MIT
