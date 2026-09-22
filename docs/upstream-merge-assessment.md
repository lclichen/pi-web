# pi-web 上游合并评估（2026-09-22 更新）

> 上游 `agegr/pi-web` 自 fork 分叉点以来 136 个新提交；本 fork 领先 201 个提交。
> 已 cherry-pick **16 个**高价值提交（三批）；另经核对，**v0.9.0 squash 合并（`a249552`）已带入 51 个提交的内容**（见文末 09-22 更新）。

## 已合入（13 个，两批）

### 第一批（6 个，基础设施 + bug 修复）

| 提交 | 内容 |
|---|---|
| `002400d` | 流式输出首块去重 |
| `974c8bb` | 从有界转录自动命名会话 |
| `31f0505` | Next.js 代理上传缓冲区 128MB |
| `c04bab7` | UNC 路径保留（文件 API） |
| `1f79174` | SSE 关闭防 Next 16 僵尸进程（instrumentation.ts 手动合并 relay+SSE） |
| `0ff1138`（部分） | Session liveness lease 基础设施（仅 lib 侧；hook 集成暂缓） |

### 第二批（7 个，功能 + 性能）

| 提交 | 内容 | 冲突处理要点 |
|---|---|---|
| `09383ae` | gzip 大 JSON 响应 | 保我们的元数据逻辑 + 上游 jsonResponse |
| `fce666a` | plugins relativePath Windows 分隔符 | 保我们的 import（sep 已有） |
| `afd2575` | npm 更新不用 npm.cmd shim | 零冲突 |
| `8df5132` | 扩展 widget 顺序保持 | 上游 helper + 扩展 metadata 参数 |
| `c844973` | 响应截断提示 | 加 isAssistantTruncated import |
| `8cbafdd` | 会话元数据缓存 | **保留 per-space 架构**，上游全局缓存不兼容多用户；2 项测试 re-skip |
| `d11d344` | 工具卡片折叠时显示图片 | 取 ResultImages，跳过 apply-patch 依赖 |

---

## 尚未合入的高价值提交

### 可合入（冲突评估完毕，下次可做）

| 提交 | 内容 | 冲突面 | 建议 |
|---|---|---|---|
| `b44017a` | 看到其他 pi 进程写的会话 | rpc-manager + session-reader + e2e | rpc-manager 是我们改动最重的文件，需逐 hunks 合并；**用户已明确暂缓** |

### 大冲突面（建议专用合并窗口）

| 提交 | 内容 | 涉及文件数 | 建议 |
|---|---|---|---|
| `ed50d88` | 侧栏面板可拖拽调宽 | SessionSidebar + globals.css + i18n | 布局改动大 |
| `f2d600b` | /auto-compact 斜杠命令 | ChatInput + useAgentSession + i18n | ChatInput 我们改过多处 |
| `3f07a5f` | 显示运行中 turn 的推理级别 | ChatWindow/MessageView | 未评估冲突面 |

### 架构冲突（暂缓或跳过）

| 提交 | 内容 | 状态 | 原因 |
|---|---|---|---|
| `237d0ca` | 启用内置子智能体 | **跳过** | 我们硬锁 isBuiltInSubagentsEnabled()=false 用 tintinweb 替代 |
| `c1e544b` | cookie SameSite=Lax | 暂缓 | 我们的登录态改动（滑动续期+90天上限）需统一处理 cookie 属性 |
| `e5a2434` | Next.js 16.3.5 升级 | 独立评估 | 框架升级涉及所有路由/中间件 |

### 子智能体 P0 批次（6 个，整体暂缓）

| 提交 | 内容 |
|---|---|
| `bbe2f7d` | tintinweb profiles 支持 |
| `2661247` | worktree 隔离 |
| `a31d5c5` | 恢复持久化会话 |
| `b77a25f` | 并发排队 |
| `e3fbbf6` | 扩展工具选择器 |
| `553f2d7` | 保留 agent profile 字段 |

**暂缓原因**：与 tintinweb 集成架构深度耦合（UI 中继 + 提示词契约）。建议随下次 tintinweb 版本升级一并评估。

### 其余未列入的提交

136 个上游提交中：51 个（v0.8.11..v0.9.0）已随 `a249552` squash 合入；余 85 个中 15 个已
cherry-pick（16 个中 `8cbafdd` 出自 squash 段，为 per-space 适配的有意重做）；**实际待合入约 70 个**，
其中上述清单覆盖约 15 个高价值项；其余为小修复、文档更新、CI 配置、i18n 补充等，可随下次大合并窗口
批量处理或等上游 v0.10 统一 merge。

## 建议下一步

1. **低成本快赢**：已无——第三批后剩余项均需评估冲突面
2. **下次合并窗口**：`ed50d88`（侧栏拖拽调宽）等大 UI 功能；`1cbd96f`（会话搜索）+ `5f8f47b`（窗口化列表）**已随 v0.9.0 squash 合入，无需再处理**
3. **等上游 v0.10**：考虑整体 merge（到时冲突面可能更大但一次性解决）
4. **持续跳过**：`237d0ca`（内置子智能体）、`e5a2434`（Next.js 16 独立评估）


## 更新（2026-09-21 第三批）

新增合入 3 个提交（全量 1099/1/13）：

| 提交 | 内容 | 冲突处理 |
|---|---|---|
| `38cba2b` | Plugins 面板显示包描述 | 保我们的 sidebar 结构 + 上游 title tooltip + detail 描述行 |
| `e70c367` | apply_patch split diff 渲染 | 三方 import 冲突（isAssistantTruncated + apply-patch），逐层合并 |
| `b42d3f4` | 工具卡片展开保持 | import 冲突，加 tool-call-expansion |

累计已合入：**16 个上游提交**（第一批 6 + 第二批 7 + 第三批 3）。
上游 plugins 测试 1 项 skip（格式与 fork 的 origin/sourceLabel 字段不兼容）。


## 更新（2026-09-22 v0.9.0 squash 合并核对）

**发现**：`1cbd96f`（会话搜索）与 `5f8f47b`（侧栏窗口化）**已在 dev 中**——随 `a249552`
（2026-09-08，"Merge upstream v0.9.0 (ce18006)"，单亲 squash 合并）进入，此前本文件将二者
误列为未合入。

**根因**：squash 合并只带内容不带提交，`git branch --contains` / `git cherry` 等基于祖先或
patch-id 的核对全部失效。凡落在 `28bab3c..ce18006`（v0.8.11..v0.9.0，51 个提交）区间的
"未合入"条目都应按内容重查。

**`1cbd96f` 核验证据**（2026-09-22，逐项比对 dev HEAD）：

- 新文件逐字节一致：`lib/session-search.ts`、`lib/session-search.test.mjs`、`components/SessionSearch.tsx`
- `app/api/sessions/search/route.ts`：功能在且更严格——加了 per-user 空间隔离
  （`requireUserIdentity` + `spaceForRequest`，含 MERGE-NOTE 标注），搜索不跨用户
- 会话列表版本管道齐全：`getSessionListVersion()`（session-reader）→ `/api/sessions` 与
  `/api/agent/running` 响应 → SessionSidebar 轮询比对刷新
- 前端跳转链齐全：AppShell `searchTarget` → ChatWindow `pendingSearchScroll`（含 tail:200
  向上翻页定位）→ MessageView `searchBlock`/`data-search-target` 高亮；`scrollToMessage`
  已演进（viewportOffset 参数，兼供滚动位置恢复）
- i18n 7 键 × 3 locale 全在；搜索相关测试通过（session-search/session-reader/
  runtime-route/MessageView；唯一 fail 为既有的 subagent relations 测试，与本功能无关）

**`5f8f47b` 核验证据**：SessionSidebar 已是窗口化渲染（`SESSION_LIST_ITEM_HEIGHT` + overscan
可见切片），对应测试（"scrolling keeps the focused session…"）在 dev 测试文件中。

**结论**：无需任何 cherry-pick；强行重放会与演进后的代码冲突或造成回退。本文件上方表格
已同步清理（第三批 3 项与本次 2 项均已移出未合入清单）。

