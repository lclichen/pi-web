# 平台文档中心

本目录是 **Amedac / pi-web 中心化多用户 Agent 平台**的框架文档入口。产品定位是：
多用户、多执行环境的中心化 Agent 智能体平台，覆盖编程、办公、服务器与软件操作。
垂直场景能力通过项目配置/外部插件扩展，不进入核心架构假设。

文档状态约定：

- **现行**：与当前代码一致，架构变更时必须同步更新。
- **参考**：专题设计/操作手册，可能比总览更细，但不应与现行文档矛盾。
- **历史**：某一时间点的评审、计划或报告，保留用于追溯，不代表当前状态。

## 1. 先读什么

| 目标 | 文档 |
|---|---|
| 了解整体架构、组件边界、数据流 | [PLATFORM.md](./PLATFORM.md) |
| WebUI 页面/请求/状态约定 | [webui.md](./webui.md) |
| 多用户、五种执行模式、权限矩阵 | [multi-user-and-modes-design.md](./multi-user-and-modes-design.md) |
| 会话、项目、workspace、删除级联 | [session-project-model.md](./session-project-model.md) |
| 全局/用户/项目配置层 | [configuration.md](./configuration.md) |
| 安全边界、信任模型、已知限制 | [security.md](./security.md) |
| 部署、升级、打包、离线分发 | [DEPLOYMENT.md](./DEPLOYMENT.md)、[packaging.md](./packaging.md) |
| 分发许可、第三方归属、特殊许可证 | [licensing.md](./licensing.md)、[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)、[LICENSES](../../LICENSES/README.md) |
| Agent Client / 本机模式 | [CONNECT_LOCAL_MACHINE.md](./CONNECT_LOCAL_MACHINE.md) |
| Sandbox Platform 集成 | [sandbox-platform.md](./sandbox-platform.md) |
| MCP（作用域/执行面/图片/分享） | [mcp.md](./mcp.md) |
| 测试策略与验收 | [全流程测试方案.md](./全流程测试方案.md)、[guardrail-test-strategy.md](./guardrail-test-strategy.md) |

## 2. 架构与运行

| 文档 | 状态 | 内容 |
|---|---|---|
| [PLATFORM.md](./PLATFORM.md) | 现行 | 组件、端口、五模式、数据流、存储与安全总览 |
| [webui.md](./webui.md) | 现行 | WebUI 页面骨架、API/SSE、权限 UI、性能/i18n 约定 |
| [multi-user-and-modes-design.md](./multi-user-and-modes-design.md) | 现行 | 平台账号/BFF、会话空间、sandbox/local-machine/SSH/Host/Quick、权限与配额 |
| [session-project-model.md](./session-project-model.md) | 现行 | SessionDescriptor、ProjectRecord、workspace 版本、删除/恢复 |
| [configuration.md](./configuration.md) | 现行 | Global / User / Project 三层配置，`.pi` 与 `state/` 的职责 |
| [security.md](./security.md) | 现行 | 控制面/执行面、路径护栏、relay 围栏、项目信任、凭据与 MCP 执行面 |
| [state-storage-inventory.md](./state-storage-inventory.md) | 参考 | 运行状态文件、JsonStore、迁移/回滚与后续 GC |
| [session-access-and-tool-bridge.md](./session-access-and-tool-bridge.md) | 参考 | 会话访问栅栏与工具桥接细节 |

## 3. 部署与交付

| 文档 | 状态 | 内容 |
|---|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 现行 | tar/AppImage 部署、配置、升级、生产加固、故障排查 |
| [packaging.md](./packaging.md) | 现行 | 离线包构建、瘦身、跨平台 agent dist、发布检查 |
| [CONNECT_LOCAL_MACHINE.md](./CONNECT_LOCAL_MACHINE.md) | 现行 | Agent Client 架构、配对、多机器、协议、构建、GUI、故障排查 |
| [sandbox-platform.md](./sandbox-platform.md) | 现行 | 平台服务职责、认证/容器/工具/PTY/配额、与 pi-web 的契约 |
| [apkg-dev-testing.md](./apkg-dev-testing.md) | 参考 | 加密配置包开发测试 |
| [commercial-protection.md](./commercial-protection.md) | 参考 | apkg 客户身份、封条、许可与边界 |
| [licensing.md](./licensing.md) | 现行 | 分发组件、修改归属、MPL/CC-BY 等特殊许可证与发布检查 |
| [sca.md](./sca.md) | 参考 | 依赖/供应链扫描流程 |

## 4. 功能与集成

| 文档 | 状态 | 内容 |
|---|---|---|
| [mcp.md](./mcp.md) | 现行 | MCP 总览：scope、执行面、relay host、身份、图片、分享 |
| [mcp-scopes-and-overrides.md](./mcp-scopes-and-overrides.md) | 现行 | project/quick/user/global 优先级与工作区墓碑 |
| [mcp-file-sharing.md](./mcp-file-sharing.md) | 参考 | `share_file` 与一次性下载链接 |
| [mcp-inline-images.md](./mcp-inline-images.md) | 参考 | MCP 图片资产与聊天内联渲染 |
| [config-sharing.md](./config-sharing.md) | 现行 | 配置包、预置模板、Host 目录包 |
| [agent-builder-demo.md](./agent-builder-demo.md) | 参考 | Agent Builder 端到端示例 |
| [embed-session-widget.md](./embed-session-widget.md) | 参考 | 会话嵌入页/产品 API |
| [feedback-api.md](./feedback-api.md) | 参考 | 消息反馈 API |
| [otlp-tracing.md](./otlp-tracing.md) | 参考 | OpenTelemetry/OTLP 链路追踪 |
| [agent-environment-dependencies.md](./agent-environment-dependencies.md) | 方案 | 依赖随包/离线的设计建议（部分未实现） |

## 5. 测试与质量

| 文档 | 状态 | 内容 |
|---|---|---|
| [全流程测试方案.md](./全流程测试方案.md) | 现行 | L0/L1/L2/L3 测试分层与回归选择 |
| [平台功能检查手册.md](./平台功能检查手册.md) | 参考 | 管理端/普通用户端功能走查 |
| [guardrail-test-strategy.md](./guardrail-test-strategy.md) | 现行 | 路径/工具护栏测试分层 |
| [path-policy-guardrails.md](./path-policy-guardrails.md) | 现行 | 路径策略、决策文件、已知绕过面 |
| [tool-guardrails-design.md](./tool-guardrails-design.md) | 现行 | 工具护栏、MCP 声明、远端执行面 |
| [e2e_playwright](../../../e2e_playwright/docs/E2E-DESIGN.md) | 参考 | 浏览器端 E2E 套件（独立仓库） |

## 6. 历史与时点文档

以下文档记录过去的评审/计划/性能报告，**不代表当前状态**；引用前先以现行文档和代码为准。

| 文档 | 说明 |
|---|---|
| [agent-framework-review.md](./agent-framework-review.md) | 2026-11 框架检视快照（部分 P0 已修） |
| [upstream-0.14-gap-and-ui-review.md](./upstream-0.14-gap-and-ui-review.md) | 上游 0.14 对照与 UI 评审快照 |
| [performance-optimization-2026-11.md](./performance-optimization-2026-11.md) | 性能优化批次报告 |
| [修复计划-2026-09-04.md](./修复计划-2026-09-04.md) | 旧修复计划 |
| [config-layers-user-scope-review.md](./config-layers-user-scope-review.md) | 配置层级改造前的检视；现行结论见 configuration.md |
| [qwenpaw-guardrails-reference.md](./qwenpaw-guardrails-reference.md) | 外部护栏参照（参考素材，不是本项目状态） |

## 6a. 已归档的根目录资料

工作区根的 `平台设计方案/` 是早期垂直场景方案的时点资料，已加归档说明，不再维护；
其链接不应作为当前架构依据。现行文档以本目录为准。

## 7. 跨仓库文档源

本仓库集中维护**框架级**文档。以下仓库保留各自领域的源文档，修改时应同步检查：

| 领域 | 源位置 | 说明 |
|---|---|---|
| Sandbox Platform API/部署/ADR | `AgentSandbox/sandbox-platform/docs/` | API-REFERENCE、DEPLOYMENT、ADR、User Guide |
| Agent Client 源码与发布 | `pi-web-0851/agent/README.md`、`agent/gui/README.md` | 本目录 CONNECT_LOCAL_MACHINE 是整合视图 |
| 打包运行时说明 | `pi-web-0851/packaging/README.txt` | 面向最终用户的包内说明 |
| Python/TypeScript SDK | `amedac-agent-sdks/` | 独立 SDK 仓库 |
| E2E Playwright | `e2e_playwright/docs/` | 浏览器自动化测试设计 |

根 `docs/` 仍保留上游/通用专题（不在 `docs/dev/` 重写）：

| 文档 | 内容 |
|---|---|
| `docs/adr/**` | 架构决策记录（project command env、tool selection、subagent toggle、projection） |
| `docs/i18n.md` | i18n 约定与迁移 |
| `docs/release.md` | 上游发布流程 |
| `docs/worktrees*.md` | Worktree 使用/行为 |
| `docs/batch-api.md` | 批量 API 使用/示例 |
| `docs/skillhub-api.md` | SkillHub API |
| `docs/deepswe-eval.md` | deep-swe 评测集成 |
| `docs/upstream-merge-assessment.md` | 上游合并评估 |

## 8. 维护约定

1. 架构变更必须同时更新 `PLATFORM.md` 与对应专题文档；无法确认时在 PR 说明中标注“文档待补”。
2. 新增框架文档放 `docs/dev/`，在本索引登记状态与受众。
3. 产品文案统一使用“多用户中心化 Agent 平台/用户/管理员/执行环境”，不使用单一垂直场景作为默认叙事。
4. 历史文档保留原文，但在索引中标记；重大结论迁移到现行文档后再标注。
5. 文档中的路径、端口、环境变量和 API 形状必须能从代码或部署脚本中验证。
