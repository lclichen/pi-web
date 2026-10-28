# 代码巡检 Agent（Agent Builder Demo）

这是「用内置 Agent Builder 从零创建一个可交付 Agent」演示的**成品参照树**：
覆盖系统提示、技能（含 references 渐进披露）、子代理、自定义扩展工具、
MCP 服务器、模型清单与依赖声明七类模块。

演示脚本与逐步话术见 `docs/dev/agent-builder-demo.md`。

快速通道（来不及走对话式构建时）：

1. 新建 Host 项目（空目录），把本目录的 `AGENTS.md` 与 `.pi/` 复制进项目 home；
2. 打开会话即可验证行为（首次会话需在 设置 → MCP 信任 `audit-memo`）；
3. 项目菜单「导出配置包」→ `apkg-publisher pack` 加密 → 设置 → Agents 管理上传。

文件清单：

| 模块 | 路径 | 演示要点 |
|---|---|---|
| 系统提示 | `AGENTS.md` | 角色、工作流、工具约定、报告格式 |
| 包声明 | `.pi/bundle.json` | 名称/版本/渠道/环境依赖 → 导出进 manifest.package |
| 技能 | `.pi/skills/code-audit-rules/` | SKILL.md 触发词 + references/checklist.md 渐进披露 |
| 子代理 | `.pi/agents/coverage-analyst.md` | frontmatter（description/tools/max_turns）+ 分析方法 |
| 扩展 | `.pi/extensions/audit-collect/` | 注册 `audit_collect` 工具（git 统计 + TODO 扫描，零依赖） |
| MCP | `.pi/mcp.json` + `.pi/mcp/memo-server.mjs` | 零依赖 stdio MCP：`memo_save` / `memo_list` |
| 模型 | `.pi/models.json` | modelList[].id —— 换成你部署里实际可用的模型 id |
