# pi-web 上游合并评估（2026-09-22 更新）

> 上游 `agegr/pi-web` 自 fork 分叉点以来 136 个新提交；本 fork 领先 201 个提交。
> 已 cherry-pick **61 个**高价值提交（七批）；另经核对，**v0.9.0 squash 合并（`a249552`）已带入 51 个提交的内容**（见文末 09-22 更新）。

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

1. **可选大功能**：`f2d600b`（/auto-compact）、`5e9b997`（PDF 页码跳转）——价值中等，冲突可控
2. **等上游 v0.10**：考虑整体 merge（到时冲突面可能更大但一次性解决）
3. **持续跳过**：`237d0ca`（内置子智能体）、`e5a2434`（Next.js 16 独立评估）、上游密码登录体系、`448e146`+`2eb95b9`（主题系统，用户确认不需要）


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


## 更新（2026-09-22 待合入盘点）

对 post-v0.9.0 段（`ce18006..main`，85 个，减已捡 15 个 = 70 待合入）逐个做了
冲突面测算（提交触碰文件中 dev 相对上游父态已分歧的数量）与价值分档：

### 第四批候选：低冲突可合（约 20 个，建议一批做完）

> **2026-09-22 已全部合入（19 个），见文末「第四批」记录。**

| 提交 | 内容 | 冲突面 |
|---|---|---|
| `47a0bb2` | **OAuth 手动码握手 token 改 crypto randomUUID（安全修复，优先）** | 1 文件，dev 与父态一致，零冲突 |
| `f607816` | 隐藏 enabledModels 残留警告 | model-scope + 测试，零冲突 |
| `2e914db` | 终端默认 UTF-8 locale | terminal-manager +3 行 |
| `50a2fd4` | 会话尾预算只计可见消息（恢复/分页性能） | session-reader 需小合（per-space 分歧） |
| `a84093e` | shutdown hook 移出 Edge instrumentation 入口（1f79174 的后续修复） | instrumentation.ts 需小合（我们重构过 relay+SSE） |
| `5173f6a` | 富文本粘贴保留链接 | 2 文件 1 分歧 |
| `a26cc68` | 行内代码转义反引号 | 2 文件 1 分歧 |
| `f3a4ff6` | 选择工具栏浮于侧栏之上 | 2 文件 1 分歧 |
| `be38e5d` | 变更文件行 @ 提及按钮 + 中部省略号路径 | 1 文件 |
| `744ee93` | worktree add 前 fetch origin + git 超时加大 | 1 文件 |
| `d2056b6` | 输入框图片附件预览 | 2 文件 1 分歧 |
| `860698a` | 扩展 widget 字号设置 | 1 文件（i18n ×3 加键） |
| `a74aef8` | sidebar=collapsed 嵌入参数 | 3 文件 1 分歧 |
| `79894b9` | 设置/auth 路由纳入扩展注册的 provider | 5 文件 1 分歧 |
| `f4a700d` | 扩展提示渲染为 markdown | 2 文件 1 分歧 |
| `ed0eea9`/`fcd94bf`/`135517b`/`894c735`/`58c1a21` | 碎片小修（滚动边缘/对话框换行/品牌/i18n 标签/.gitignore） | 各 1-2 文件 |

### 中等冲突：有价值，逐个评估（约 14 个）

> **2026-09-22 第五批已全部处理**：12 个合入（见文末「第五批」记录）；`ef51ffd` 跳过——fork 的
> 合成 top-level 分组体系（classify/makeClassifier，含来源徽章+更新检查+目录移除，覆盖
> extensions/skills/prompts/themes 四类）已比上游的 standaloneExtensions 方案更完整，硬合会双轨重复。

### 大功能：专用合并窗口（约 8 个）

> **2026-09-22 第六批**：`ed50d88`（侧栏拖拽调宽）与 `ffb2daf`（文件面板全宽）已合入（用户指定）；
> `448e146`（主题系统）+ `2eb95b9`（设置页主题/语言控件）**用户确认跳过**（无必要）。
> **第七批**：`5e9b997`（PDF 页码跳转，RAG 场景）已合入。其余待定：`f2d600b`（/auto-compact）、
> `6d53fd5`+`6e95fba`（provider 配额）、`3e9fcfa`（iOS 推送）。

### 维持既定决策（跳过/暂缓，约 22 个）

上游密码登录体系 `e685cac`+`20ad98b`（fork 自有登录态；节流逻辑可参考）、`c1e544b` SameSite、
`e5a2434` Next.js 16、`b44017a`（用户暂缓）、`237d0ca`（squash 段内已按硬锁排除）、
子智能体系列 11 个（`b77a25f`/`a31d5c5`/`bbe2f7d`/`2661247`/`e3fbbf6`/`553f2d7`/`b5b52f0`/
`f106531`/`e83f4b5`/`9d282da`/`20a2579`，tintinweb 耦合）、`404923e` RISC-V Wasm、
`8366762` Release v0.9.1（版本提交）；文档/CI/纯测试 10 个（AGENTS.md 仅 1 行分歧，可随批带上）。


## 更新（2026-09-22 第四批）

合入 19 个提交（全量 1124/1/13，唯一 fail 既有；`tsc --noEmit` 通过）。三处 fork 适配：

| 提交 | 内容 | 适配 |
|---|---|---|
| `2e914db` | 终端默认 UTF-8 locale | 上游 terminal-manager 已被 fork 的 `lib/local-terminal.ts` 取代——LANG 修复移植到 local-terminal 的 pty.spawn env，补源码断言测试 |
| `135517b` | 新会话品牌与输入框对齐 | 保留 fork 品牌 amedac.ai 与 CHAT_COLUMN_PADDING 布局，仅换 apple-touch-icon 图标 + 居中对齐 |
| `a84093e` | shutdown hook 移出 Edge 入口 | fork 的 relay 启动与完整 shutdown（SSE+relay+grace exit）一并移入新 `instrumentation-node.ts`，入口改正向 NEXT_RUNTIME 分支 |

其余 16 个零冲突直捡：`47a0bb2`（**安全**：OAuth 手动码 token 改 crypto randomUUID）、`f607816`、`5173f6a`、
`a26cc68`、`f4a700d`、`a74aef8`、`894c735`、`fcd94bf`、`ed0eea9`、`744ee93`、`860698a`（widget 字号
实为 globals.css 跟随聊天字号变量，无需 i18n）、`d2056b6`、`58c1a21`、`be38e5d`、`f3a4ff6`、
`50a2fd4`（可见消息尾预算，session-reader 自动合并成功）。

累计已合入：**35 个上游提交**（四批）。待合入剩约 51 个（中等档 13 + 大功能 8 + 跳过/暂缓 22 + 文档/CI/测试 10，部分重叠）。


## 更新（2026-09-22 第五批）

合入 12 个提交 + 跳过 1 个（全量 1153/1/13，唯一 fail 既有；`tsc --noEmit` 通过）：

| 提交 | 内容 | 冲突处理 |
|---|---|---|
| `0e71201` | 大文本预览分页（load-more） | FileViewer 合并 offset 参数与 fork 的 remote 参数；remotefs 无分页但从不清 truncated，UI 不会出现 load-more |
| `ed840ed`+`b1a7296` | 会话模型准确恢复+测试 | rpc-manager 仅 import 块冲突（fork 的 getLatestModelChange 已由 session-reader 侧带入） |
| `d10988d`/`585d56c`/`def1478`/`dab9850`/`1b88ec7`/`3f07a5f`/`b4a4539` | 重复命令/首消息 fork/SSE 重连 shell 输出/@ 选择器×2/**推理级别显示**/PWA 上限 | 零冲突直捡 |
| `4787a14` | 打开活跃会话保留流式输出 | dispatch "resume" 与 fork 的 maintainEventsConnected 调用合并保留 |
| `1eb5e66` | 滚到底部按钮 | 按钮插入 fork 的 composer 容器首位（去掉冗余 isEmptyNew 包装，fork 此处已在非空态分支内），CSS 动画/`pendingScrollRestore` 互斥完整保留 |

`ef51ffd`（插件设置显示顶层扩展）跳过：fork 的合成 top-level 体系已覆盖且更完整。

累计已合入：**47 个上游提交**（五批）。待合入剩约 41 个（大功能 8 + 跳过/暂缓 23 + 文档/CI/测试 10）。


## 更新（2026-09-22 第六批）

用户指定：合入侧栏调宽与文件面板全宽；主题系统确认跳过；文档/CI/纯测试不冲突即引入。
合入 12 个（全量 1157/1/13，唯一 fail 既有；`tsc --noEmit` 通过）：

| 提交 | 内容 | 冲突处理 |
|---|---|---|
| `ed50d88` | 侧栏会话/文件面板上下拖拽调宽 | 两处 JSX 冲突：根容器加 resizer ref+CSS 变量并保留 RemoteConnectWizard；会话面板 flex 合入 fork 的 `!hideFileExplorer` 条件；resize handle 显示条件同样补 `!hideFileExplorer`（否则资源管理器隐藏时 handle 孤立） |
| `ffb2daf` | 文件面板全宽开关 | 零冲突直捡 |
| `6edbecb` | AGENTS.md API 映射表同步 | **手工适配**：上游 17 条中 12 条直接采用；不存在的 4 条（web-auth、terminal/[id]、provider-usage）改写为 fork 实际形态（webauth/*、terminal/create\|shells\|[sid]/*）；另补 fork 自有路由组（batch+SSE stream、admin 面板、sandbox、projects 等）使映射表与部署实际一致 |
| 其余 9 个 | `55df7d7`/`eac6f14`（e2e 修复）、`fad65c9`/`17ad5c5`/`5b96a9d`/`ed7a4d7`（AGENTS 文档）、`c8c63a1`（CLI --help）、`0ff32dd`（i18n 文档）、`effa464`（CI Node 固定 22.19.0） | 零冲突直捡 |

`448e146`（可读性主题+选择器）+ `2eb95b9`（设置页主题/语言控件）：**用户确认跳过**。

累计已合入：**59 个上游提交**（六批）。待合入剩约 29 个，全部为既定跳过/暂缓或低价值待定项（`f2d600b`、`5e9b997`、配额、iOS 推送）。


## 更新（2026-09-22 第七批）

用户指定：合入 PDF 页码跳转（RAG 引用场景）+ Next.js 升级评估。合入 2 个 + 1 个 fork 自研功能：

| 提交 | 内容 | 冲突处理 |
|---|---|---|
| `5e9b997` | 聊天/预览中 `#page=N` 链接直达 PDF 指定页（RAG 页码引用的渲染端闭环） | 三处 props 冲突：ChatWindow `onOpenFile` 加 page 参数保留 fork 全部相邻属性；AppShell/FileViewer 保留 `onDirtyChange`/`remote` 并加 `initialPage` |
| `e5a2434` | Next 16.3.1→16.3.5（修两个未认证 RCE） | `images.unoptimized` 已随 #846 在 config 中，仅 bump 版本+lockfile；**本机 webpack 构建在 16.3.1/16.3.5 均 OOM（6GB 堆）——机器限制非回归**，16.3.x 补丁级 SWC 二进制矩阵不变，Rocky 8.6 wasm 构建路径不受影响；最终以 VM 构建为准 |
| （fork 自研） | 系统提示词追加 Web 输出能力说明（`lib/web-system-prompt.ts`）：markdown 图片不进代码围栏、相对/绝对/URL 三种源、%20 编码、先建文件再引用、PDF `#page=` 引用；经 `prepareNextTurnWithContext` 幂等追加，普通+chat-only 会话启用，quick 模板/子智能体/强制空提示词不动 | `7c6d6a5` |

验证：全量 1169/1（既有）/13 skip + `tsc --noEmit` 干净。

累计已合入：**61 个上游提交**（七批）。待合入剩约 27 个，全部为既定跳过/暂缓或低价值待定（`f2d600b` /auto-compact、配额、iOS 推送）。



