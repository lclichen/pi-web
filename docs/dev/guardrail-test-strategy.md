# 护栏测试策略：单元 → 链路 → 前端 的分层组织

> 目的：回答"未覆盖的部分怎么补、链路/前端问题如何组织测试与评估"。
> 现状基线：c8 全量（2026-11-08）statements 29.81%（全项目）/ 56.71%（已执行
> 文件）；lib 已执行口径 81.80%，app 路由 9.11%、components 9.36%、hooks 9.11%。
> 覆盖缺口集中在**路由运行时**与**前端交互**，不是护栏判定核心。

## 1. 分层模型（测试金字塔改造版）

| 层 | 对象 | 工具/形态 | 速度 | 频率 |
| --- | --- | --- | --- | --- |
| L0 纯函数 | `path-guard-policy` / `tool-policy` / `tool-manifest` / `guardrail-audit` | node --test + jiti | 秒级 | 每次提交 |
| L1 扩展行为 | `path-guard.ts`（tool_call 拦截、四选、决策持久化） | 桩 pi/ctx harness（已有 `path-guard.test.mjs`） | 秒级 | 每次提交 |
| L2 服务端链路 | `rpc-manager`（装配/钳制/get_state/extension UI/事件流） | 真实 `AgentSessionWrapper` + 桩 inner（已有 `tool-policy-clamp.test.mjs` 模式） | 秒级 | 每次提交 |
| L3 真实 Agent 循环 | 工具调用 → 护栏 → 模型可见结果 | faux provider e2e（已有 `path-guard-e2e.test.mjs`） | 1-3s | 每次提交 |
| L4 路由运行时 | `/api/policy`、`/api/tools/policy`、`/api/agent/[id]/events` | 直接 import handler + 构造 Request/cookie（现在是源级契约，需升级） | 快 | 每次提交 |
| L5 前端交互 | `ExtensionDialog` select、会话切换、事件流重放 | Playwright/IAB 脚本 + 截图/DOM 断言 | 分钟 | 每日/发布前 |
| L6 端到端 | 真模型/多模式/多用户 | Python SDK QA 套件（`pi-web-agent-sdk/qa`）+ 人工清单 | 十分钟 | 每日/验收 |

原则：**L0-L3 已较完整，优先补 L4/L5**；L6 已覆盖 API 面，不重复做同一事。

## 2. 未覆盖部分的补测清单（按优先级）

### P0：护栏 ask 生命周期（当前最大风险）
- [ ] `requestExtensionUi`（lib/rpc-manager.ts:2182）单测：
  - 无 timeout + `askAutoContinue` 关 → 永不自动结算（断言 pending 存在）；
  - `askAutoContinue` 开（`PI_WEB_ASK_TIMEOUT_MS`）→ 到期按 defaultValue 结算，前端事件含 `timeout/expiresAt`；
  - 显式 `opts.timeout` 优先于用户设置；
  - `refreshAskTimeouts()` 在开关切换时重挂/取消倒计时；
  - `shutdown()` → `pending.cancel()` → select 解析为 `undefined`；
  - 新 listener 订阅时 `pendingUiRequests` 重放（onEvent 语义）。
- [ ] **路径护栏 ask 显式超时**：目前 `ctx.ui.select(..., undefined)`（path-guard.ts）
  不传 timeout → 会话可无限挂起（pending ask 期间 `isRunning()` 为真，idle 销毁
  不会触发）。建议传 300s 并在超时文案上与"用户拒绝"区分（计划项）。
- [ ] e2e：四选分支（允许一次/始终允许/拒绝/拒绝且不再询问）在真实 AgentSession
  中各跑一次（现有 e2e 只覆盖 deny/headless）。

### P1：路由运行时（L4）
- [ ] `/api/policy` 四个方法的行为测试（高于现有源级契约）：身份门禁、PUT 规范化、
      决策删除、试运行与护栏同判定、锁定语义（admin/user）。
- [ ] `/api/tools/policy`：mode 解析（项目/host）、MCP 剔除集合、声明透传。
- [ ] `/api/agent/[id]/events`：SSE 重连时 pending UI 重放、断线后 `extension_ui_closed`。

### P2：前端交互（L5，Playwright/IAB）
- [ ] ask 弹窗：四个选项/数字快捷键/取消 → 分别发送正确的 `extension_ui_response`；
- [ ] **切出会话再切回**：弹窗消失（组件重挂载）→ 切回后重放出现、倒计时剩余正确；
- [ ] 会话被 idle 销毁/服务重启：弹窗消失，工具调用以拒绝收尾；
- [ ] deny 在消息流中呈现为工具错误卡（reason 可见、可读）；
- [ ] 工具护栏横幅（P2b）与设置页声明矩阵的一致性；
- [ ] 多请求竞争：同一会话内若出现第二个 UI 请求（并发工具场景），当前单槽
      `extensionDialog` 行为需明确（串行纪律 or 队列化）。

### P3：组件/钩子单测补强
- [ ] `useAgentSession`：事件流重连、session 切换时 dialog 清理、`extension_ui_closed` 竞态；
- [ ] `ExtensionDialog`：不再只做源级断言，补 SSR 渲染 + 回调触发（可用
      `react-dom/server` + 直接调用 props 回调验证 payload）。

## 3. 链路/前端问题的评估组织

### 3.1 场景矩阵（状态机式，而不是"按页面点一遍"）

| 维度 | 取值 |
| --- | --- |
| 护栏动作 | allow(rule) / allow(ask-once) / allow(always) / ask / deny(rule) / deny(headless) / deny(ask) / deny(超时) |
| 触发工具 | bash / powershell / bg_run / write / edit / read / share_file |
| 会话状态 | 当前会话 / 切走 / 切回 / 刷新页面 / 多窗口 |
| 时间点 | 判定瞬间 / 等待中 / 结算后 |
| 模式 | host / sandbox / local-machine / quick |
| 身份 | admin / 普通用户 / 无人值守（batch/bench） |

组合不必全排列：用**风险驱动抽样**——每个"中断点 × 动作"至少一条，优先
`ask × 切走/切回 × 刷新`、`deny × 多模式`、`allow-once × 会话内重复`。

### 3.2 评估标准（每条场景必须可观测）

1. **UI 断言**：弹窗/横幅/工具错误卡的 DOM 或截图；
2. **协议断言**：`extension_ui_response`/`extension_ui_closed` 事件序列；
3. **服务端状态**：`get_tools` 活动集、`pendingUiRequests`、`toolPolicy`；
4. **落地副作用**：文件是否写入、审计 JSONL 是否有记录；
5. **模型可见性**：ToolResult `isError` 与 reason 文本。

任一项缺失即视为"测试不可判定"，先补观测点再谈通过与否。

### 3.3 失败分类（评估时强制归档）

- **产品缺陷**：行为与设计不符（如无限挂起、跨会话错投响应）；
- **测试环境**：dev server/proxy/CI 差异（如本次 Windows Git Bash `/tmp`）；
- **测试代码滞后**：重构后断言未更新（如 FileViewer 守卫、stream-route）；
- **预期行为**：如 cancelled 任务不可 resume（409）。

### 3.4 执行编排

- **每次提交**：`npm test`（L0-L3）+ `tsc --noEmit`；
- **每日**：L4 路由测试 + Python SDK QA（`-m functional,streaming,files,resilience`）；
- **发布前**：L5 Playwright 场景包 + L6 多用户/本机模式 + 人工 QA 清单；
- **回归专项**：任何改动 `rpc-manager`/`path-guard` 的 PR，必跑 ask 生命周期用例。

## 3.5 已落地（2026-11-13）：护栏 UI 场景包

`e2e/run-guardrails.mjs` + `e2e/mock-model.mjs`（`npm run test:e2e:guardrails`）：

- **确定性输入**：本地 OpenAI 兼容 mock 模型让真实 Agent 循环发起一次
  `write`（工作区外路径）→ 路径护栏 ask；无需真实模型。
- 已覆盖：ask 四选（允许一次/拒绝/拒绝且不再询问/本项目始终允许）、决策文件、
  第二次同目标不再询问、切会话隐藏与重放、刷新重放、护栏原因回给模型/UI。
- 测试暴露并修复的真实缺陷：**持久决策/策略中的 Windows 盘符绝对路径**
  （`C:/...`）被当成相对路径拼到 cwd 下，导致“不再询问”在 Windows 失效；
  已修 `matchesPattern` 并加单测（`lib/path-guard-coverage.test.mjs`）。
- 已知限制（默认跳过，`E2E_MULTI_WINDOW=1` 复现）：**会话存在 pending ask 时，
  新开第二个窗口会停在“正在加载会话...”**；另一顺序（先开双窗再发 prompt）
  则第一窗口在第二窗口加载后输入框消失。需要单独排查 RPC 事件流与页面加载
  的交叉问题。

## 3.6 已落地（2026-11-13）：L4 路由真实 handler 行为测试

三条路由从“源级契约”升级为**直调 handler**（auth off = 隐式 host admin，
`PI_WEB_DATA_DIR` 注入临时数据目录）：

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `app/api/policy/policy-route.behavior.test.mjs` | 5 | GET 默认值/锁定、Host/Origin 门禁、PUT 规范化与 Content-Type、DELETE 决策删除、POST 试运行（命令/路径/scope 映射） |
| `app/api/tools/policy/route.behavior.test.mjs` | 3 | host vs sandbox 项目模式解析、stdio/HTTP/`plane=host`/`workspace` 声明分流、门禁 |
| `app/api/agent/events-route.behavior.test.mjs` | 3 | aborted→204、未知会话→404、合成会话→SSE 200（text/event-stream） |

又暴露并修复一个真实缺陷：**Windows 盘符路径的决策记录无法通过
`DELETE /api/policy?path=...` 删除**（只接受 `/` 开头）——现已接受盘符绝对路径。

## 3.7 已落地（2026-11-13）：remote 工具层单测（relay / ssh）

为两条远端工具层补上缺失的单测（此前只有桥接/路径工具的部分覆盖），
给工厂增加**测试注入缝**（生产默认仍走真实通道）：

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `lib/extensions/relay-tools.test.mjs` | 10 | base/legacy-prefix 两种路径策略、绝对路径透传/相对化、无 Agent/版本过低 fail-closed、write + AGENTS.md 镜像、edit 读改写与歧义检测、bash argv/cwd/非零退出、ls/find/grep 参数与空结果、runtime-config 桥接、user_bash 走 exec.run |
| `lib/extensions/ssh-tools.test.mjs` | 8 | exec workdir/timeout/非零退出、SFTP 相对/绝对路径、write 建父目录、edit 读改写、ls 排序与空目录、grep/find 命令转义拼接、桥接不发 SFTP、user_bash `cd workdir` 与 exit 结算 |

注入缝：`RelayToolsOptions.rpc/agentForUser`、`makeSshToolsExtension({getClient, exec})`。

## 4. 现状已知风险（本轮核对发现）

1. **路径护栏 ask 无硬超时**：仅当用户开启"问询自动继续"（默认 300s）才会自动
   结算；默认关闭时永久等待，且 pending ask 会让会话 `isRunning()` 保持为真，
   idle 销毁不会触发——最坏情况会话永久卡住。
2. **超时/销毁与"用户拒绝"共用文案**：select 结算为 `undefined` 后护栏回
   "用户拒绝了本次操作"，语义不准确（应在事件里带 `timedOut/cancelled` 区分）。
3. **单槽 dialog**：`extensionDialog` 只保留最后一个 UI 请求；当前工具调用串行
   时无碍，但并发工具/多请求时可能丢失前一个（需要队列化或明确保证）。
4. **多窗口 + pending ask 的加载缺陷**（UI 套件暴露）：见 §3.5 已知限制。
5. **前端无 allow 可见性**：规则 allow 与"允许一次"都无任何 UI 痕迹（只有审计
   JSONL + 设置页试运行）；对"为什么这次没问"缺乏可解释性。
