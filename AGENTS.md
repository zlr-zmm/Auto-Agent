# Agent Rules

- 这个仓库是飞书 SuperAgent 的引擎本体；改动要保持零依赖（仅 node: 内置模块）与既有命令兼容。
- 提交前跑 `node superagent.mjs state` 和 `node --test "test/*.test.js"`（有测试后）；新增功能要配测试。
- 保持确定性层与判断层分离：superagent.mjs 不调用任何 LLM；提示词类改动只进 SKILL.md。
- Outbox 语义不可破坏：先落盘 pending 再执行外部动作；所有写操作必须幂等。
- commit message 一行式并带工单 ID，如 `task-20261121-201: add stddev command`。
- PR 描述以 "This is by an automated agent, not a human." 开头；人 merge。
