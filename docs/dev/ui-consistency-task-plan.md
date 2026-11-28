# dev-1.6.0 UI 一致性修正任务计划（交给 UI Agent）

> 日期：2026-11-28
> 分支：`dev-1.6.0`（基于 upstream main@432366bd，pi-web 0.18 / pi 1.6）
> 本文件只列 **UI/视觉/交互一致性** 任务。功能接线已在本轮补齐，见 §1。
> 约束：不新增依赖、不改功能语义；所有改动完成后必须保持 §5 的测试与 `tsc` 绿。

---

## 0. 背景与总原则

0.9.0 合并 0.18 时，上游的 AppShell / ChatWindow / MessageView 结构替换了产品的旧壳，
当时优先恢复了数据与 API 路径，UI 入口和样式只做了“能跑”的接入。当前状态：

- 产品功能入口基本恢复（详见 §1），但新恢复的面板大量使用 **旧组件 + 内联样式**，
  与 0.18 的设计语言（Settings 面板、右侧面板、项目树、紧凑工具栏）不一致。
- 旧组件里还有 **硬编码中文文案**，与 i18n 全英文 dot-key 规则冲突。
- 新增的 4 个侧抽屉（plan / subagents / git / platform-admin 入口）没有统一的
  容器、焦点、断点和层级规则。

UI Agent 的目标不是“重画整个产品”，而是：

1. 让恢复的功能看起来属于同一个产品；
2. 移动端可用（不被右侧面板/设置层遮挡、可关闭、可滚动）；
3. 文案、图标、间距、颜色全部走现有设计 token 和 i18n；
4. 不破坏已通过的源级契约测试（它们比截图更早发现接线回退）。

---

## 1. 本轮已补齐的功能（不要改语义）

| 功能 | 入口/文件 | 关键契约 |
| --- | --- | --- |
| 状态胶囊 | `components/ChatWindow.tsx` 挂载 `ChatStatusWidget` | todos / bg tasks / subagents / plan mode / goal / stop；plan 行打开计划面板 |
| 计划面板 | `AppShell` 抽屉 + `PlanPanel` | `OPEN_PLAN_PANEL_EVENT`（`lib/open-plan-event.ts`）；`exit_plan_mode` 卡片内预览 + 打开按钮（`MessageView`） |
| 计划实时刷新 | `hooks/useAgentSession.ts` | `onPlanActivity` 在 `plan_save` / 写计划文件的 tool end 触发重新探测 |
| 子智能体 | `useAgentSession.subagentCalls` + `SubagentDirectoryPanel` 抽屉 | 历史重建 + Agent tool start/end 实时更新 |
| 消息反馈 | `MessageView` 内 `MessageFeedback` | 仅 assistant 消息、hover 显示、`feedback.up/down` |
| Quick 模板 | `QuickTemplateBar` + ChatWindow 底部 | 发送前可切换并跟随工作区；发送后只显示快照（stale/detached） |
| Quick 文件区 | `SessionSidebar` `hideFileExplorer` | quick 会话隐藏 files tab / 面板，自动回 sessions |
| Git 面板 | `SessionSidebar` 文件工具栏 Git 图标 + `AppShell` 抽屉 | 仅本地工作区；远程显示禁用提示 |
| 平台管理 | `EnvironmentsMenu` 管理员项 + `PlatformAdminDialog` | 仅 admin |
| 远程文件 | `TabBar`/`file-tab-state` 的 `Tab.remote` | 文件页绑定打开时的后端，不跟随当前选中会话 |
| 远程 DOCX | `/api/remotefs?type=preview` | 复用 `lib/docx-preview.ts` 的自包含 HTML |
| 远程文件监听 | `/api/remotefs?type=watch` | 轮询 SSE：`connected` / `change` / `ping` |

仍未恢复（不要在本任务中硬做）：

- **Lab Training 面板**：pi 1.6 的扩展 widget API 删除了 `metadata`（上游
  `ExtensionWidgetOptions` 只有 `placement`），旧 `lab-training` 扩展的状态无法到达前端。
  需要扩展侧换协议（例如状态写入 widget 行 JSON 或 session 文件），不是 UI 任务。
- **SessionToolbar 的 MCP/Agents 快捷 chip**：旧工具栏已退役；这些入口现在在
  Settings / 状态胶囊内。是否需要回到 composer，属于产品决策，先不做。

---

## 2. 统一设计决策（先定，再改）

建议 UI Agent 先落一个共享容器，避免每个抽屉各写一套：

### 2.1 SideDrawer（新增，`components/ui/SideDrawer.tsx` 或 `components/SideDrawer.tsx`）

要求：

- 右侧滑入，桌面宽度档位：`sm=420`（平台管理/教学）、`md=560`（plan/subagents）、
  `lg=720`（git）；移动端 `100vw`，`padding-bottom: env(safe-area-inset-bottom)`。
- 结构：`backdrop`（点击关闭）+ `panel`（`role="dialog" aria-modal`）+ 固定头部
  （标题、可选副标题、关闭按钮）+ 可滚动 body。
- 关闭按钮触达区 ≥ 44×44（视觉图标可 16–18），`title`/`aria-label` 走 i18n。
- Esc 关闭已有全局实现（`AppShell`），共享组件接管后移除重复 effect。
- 焦点：打开时 focus 首个可交互元素/标题容器；Tab 循环；关闭后焦点回到触发按钮。
- 背景滚动锁；`aria-hidden`/`inert` 主内容（可复用 AppShell 现有 `inert` 模式）。
- z-index：**≥ 300**（当前抽屉 300；移动右侧面板 240/250，Settings 1000）。
- 样式用现有 token：`--bg` / `--bg-panel` / `--border` / `--text*`，不要新色值。

验收：Plan、Subagents、Git 三处抽屉都换成该组件；视觉上头部高度、关闭按钮、
backdrop 透明度一致。

### 2.2 文案与 i18n

- 所有新 UI 文案必须走 `useI18n` / `translate`，en / zh-CN / zh-TW 三文件 key 集一致，
  改完运行 `node scripts/i18n-normalize.mjs`。
- 硬编码中文清理（UI Agent 负责）：
  - `components/PlanPanel.tsx`：空态两行、“计划版本”/“切换计划版本”、历史版本只读等。
  - `components/GitPanel.tsx`：视图切换、staging、commit、AI review/commit message、
    错误与按钮 title 等（约 13 处汉字）。
  - `components/PlatformAdminDialog.tsx`：检查是否仍有旧中文（用户/容器/镜像表头）。
  - 已恢复的 `ChatStatusWidget` / `SubagentDirectoryPanel` / `MessageFeedback` 用 t()，
    但请对照 key 是否都在三语言里存在。
- 遵守用户既定的“前端文案最小化”：删常显次级标签/说明/微文案，必要信息用
  info tooltip；危险操作后果和可访问名称必须保留。

### 2.3 颜色/间距 token

- `MessageFeedback` 的 `#22c55e` / `#f87171` 改为 `--success` / `--danger`（若没有
  `--success` 则用现有一致绿色 token；不要新增裸色值）。
- `ChatStatusWidget` 内的 warning 色使用 `--warning`，避免 `#d97706` 裸值。
- 抽屉 backdrop 统一为 `rgba(0,0,0,.32)` 或现有 modal token；不要一个 0.32 一个 0.5。

---

## 3. 逐项 UI 问题与任务

### P0-1 三个侧抽屉的统一（Plan / Subagents / Git）

文件：`components/AppShell.tsx`（当前 `zIndex: 300` 的三段内联抽屉）。

问题：
- 宽度 560 / 560 / 720 不一致；
- 头部标题/关闭按钮各自内联，关闭按钮 18px；
- 没有焦点陷阱、背景滚动锁、触发按钮焦点回归；
- `PlanPanel` 自带高度/滚动，`GitPanel` 自带 header/close，套在抽屉里出现“双层头部”风险
  （GitPanel 的 close 与抽屉 close 重复）。

任务：
1. 落 §2.1 `SideDrawer`，替换三段内联结构。
2. `PlanPanel` 去掉自身外框假设，作为纯内容（保留版本切换头部？可上移到 drawer 头部右侧）。
3. `GitPanel` 的 `onClose` 改为由 drawer 关闭；删除面板内部重复关闭按钮或改为次级操作。
4. 移动端：`orientation` 全屏、底部 safe area、标题不被 notch 遮挡。
5. 打开时主内容 `inert`；Esc 已有全局实现，改由抽屉统一管理。

验收：
- 桌面/移动端打开/关闭、Esc、backdrop、Tab 循环、焦点回归全部正常；
- 右侧文件面板已打开时，抽屉仍在其上方（z300）；
- 三个抽屉头部高度/关闭按钮一致。

### P0-2 Quick 模板条

文件：`components/QuickTemplateBar.tsx`、`components/ChatWindow.tsx`（composer 上方）。

问题：
- 原生 `<select>` + 内联样式，与产品的 chip/pill 语言不一致；
- “⚡ Template + select” 独占一行，和 `newSessionContextBar`（项目/worktree 行）
  形成两条上下文条，信息层级重复；
- 发送后只读快照的样式（hash、stale/detached）与 chip 不一致；
- 窄屏下 `maxWidth:260` 可能挤压。

任务：
1. 改成与旧 `SessionToolbar` quick chip 一致的 pill：⚡ + 模板名 + 下拉箭头；
   点击弹出菜单（可用现有菜单模式），当前项高亮；发送前可选择。
2. 发送后显示“模板名 · hash8”+ stale/detached 状态点，title 解释；
   不再显示 select。
3. 位置建议：合并进 `newSessionContextBar` 的同一行右侧，或 composer 工具条；
   避免两条独立横条。
4. 窄屏：允许模板名 ellipsis；菜单不超出 viewport。
5. 保留 `onNewSessionTemplateChange` 语义：新草稿切换会解析 `/api/quick-workspace/<id>`。

验收：
- 新建 Quick 草稿时可切换，切换后 cwd/模型/MCP 跟随；
- 发送后不可切换，只显示快照；
- 三语言文案正确；
- `ChatWindow` 截图在 360/768/1280 宽度不溢出。

### P0-3 状态胶囊的位置与共存

文件：`ChatStatusWidget.tsx`（挂载点 `ChatWindow`）。

问题：
- 胶囊 `top:12 right:36 z45`，NoticeShelf 容器 `top:12 right:0 z40`，两者在同一角，
  通知出现时重叠；
- 新壳的 `capsuleTopPad` 只加在消息容器 padding-top，空会话 hero 不受影响；
- 窄屏/移动端胶囊宽度与 minimap 右侧偏移需要实测；
- 与 plan/agents 抽屉的触发关系需要视觉提示。

任务：
1. 明确右上角优先级：通知 > 胶囊，或胶囊在通知出现时下移/收起（给出规则并实现）。
2. 移动端位置（不遮 composer、不遮 minimap），展开面板宽度适配。
3. plan/agents 行 hover/active 状态与抽屉打开态一致。
4. `onTopReserveChange` 实测首条消息不被遮挡；会话切换后归零。
5. 空会话（hero）不显示或延迟显示，避免与新会话品牌区抢焦点。

验收：有/无通知、有/无运行任务、移动/桌面四种组合截图通过。

### P0-4 计划卡与计划面板内容

文件：`components/MessageView.tsx`（`exit_plan_mode` 卡片）、`components/PlanPanel.tsx`。

问题：
- 计划卡预览用 `MarkdownBody` + 渐变 + 按钮，视觉上像嵌套 markdown 容器，
  与 tool card 的紧凑语言不完全一致；
- 计划面板空态/版本选择器/历史只读区是旧样式 + 中文；
- 版本切换用原生 select，和产品 chip 不一致。

任务：
1. 计划卡：统一 tool card 内边距、边框色、渐变高度（建议 48–64px）、按钮为次级按钮；
   长计划预览可折叠。
2. 计划面板：头部（版本切换）与内容分离；版本切换改为菜单/chip；空态文案走 i18n，
   提供“如何生成计划”的一行提示（info tooltip 或空态说明，遵守文案最小化）。
3. 历史版本只读提示样式统一。
4. 计划面板在 drawer 内滚动，不出现双滚动条。

### P1-1 消息反馈与 assistant 动作行

文件：`MessageView.tsx`、`MessageFeedback.tsx`。

问题：
- 反馈按钮 22×22、无文字，与 copy 按钮（带文字 label）并排时基线/间距不一致；
- hover 才显示，但按钮本身仍有 opacity 0/1 双份逻辑；
- 颜色裸值。

任务：
1. 统一 assistant 动作行高度（22px）与 gap；反馈按钮与 copy 图标中心对齐。
2. 选中态用 token；hover 态与 copy 一致。
3. 可访问名称/`aria-pressed` 保留；触屏下始终可点（不依赖 hover）。
4. 去除重复 opacity/pointerEvents 逻辑（只保留一处）。

### P1-2 侧栏文件工具栏的 Git 入口

文件：`SessionSidebar.tsx`（`gitButton`）、`FileExplorer` 无改动。

问题：
- Git 图标插在 terminal 前，新增一个 13/14px 图标后工具栏更挤；
- 远程会话显示禁用图标 + tooltip，但视觉上仍占位；
- quick 模式整个 files 区隐藏后，只剩一个 sessions tab，tablist 视觉空。

任务：
1. 明确文件工具栏顺序与分组（建议：打开类 [terminal, file manager] · 内容类
   [upload, refresh, hidden] · 视图类 [files, changes, git]），用分隔线/间距分组。
2. 远程会话：Git 入口直接隐藏而不是禁用（当前 `gitButton` 渲染但 disabled）。
3. quick 模式：隐藏 files tab 后，`sidebar-tabs-list` 只有一个 tab 时是否保留 tab 条；
   给出处理（隐藏 tablist 或显示 Quick 标识），保证 header 不空洞。
4. 移动 stacked 模式下，新增图标不挤压 label；折叠态仍可见。

### P1-3 EnvironmentsMenu 管理员项与平台管理弹窗

文件：`EnvironmentsMenu.tsx`、`PlatformAdminDialog.tsx`。

问题：
- 管理员项排在 SSH 之后，和普通环境项混在一起，缺分隔；
- 平台管理弹窗是旧版大表格样式，和 Settings 面板的卡片/行高不一致；
- 菜单项描述较长，窄屏截断规则未定义。

任务：
1. 管理员项放菜单底部，加分隔线/分组标题（若菜单支持）。
2. 平台管理弹窗统一 modal 外壳（标题、关闭、滚动、焦点），表格行高/字体贴近
   Settings 的 resource 页。
3. 窄屏：菜单项两行布局（title + desc），desc 单行 ellipsis。
4. 仅 admin 可见，非 admin 不占位。

### P1-4 远程文件页与远程终端的一致性

文件：`AppShell.tsx`（FileViewer/Terminal tab）、`FileViewer.tsx`、`WorkspaceTerminal.tsx`。

已修：文件页绑定 tab 自己的 `remote`，不跟随当前会话。
仍需 UI 确认：
1. 远程文件 tab 的标题/图标是否标识远程来源（当前只有 `remote.label` 在部分位置）；
   tab 上可加小型远端徽标，title 说明后端。
2. 远程文件 watch 现在可用（轮询 SSE），加载/断线提示与本地一致。
3. 远程终端 tab 与本地终端 tab 的图标/标题区分；关闭/重连状态一致。
4. 远程会话的 files tab 隐藏 file-manager 后，工具栏不要留空位。

### P2-1 死组件清理（视觉无直接影响，但避免后续误用）

在确认无动态导入后删除：

- `components/SessionToolbar.tsx`（Quick chip 已抽出；其余入口在 Settings/胶囊）
- `components/MonacoEditor.tsx`、`components/MonacoDiffEditor.tsx`（现用 Prism/patch diff）
- `components/MathBlock.tsx`（现用 `MarkdownBody.MathDisplay`）
- `components/McpConfig.tsx`（现用 `McpServersConfig`；同时清理 `app/settings.css` 里
  `Settings › MCP (components/McpConfig.tsx)` 的孤立样式）
- `components/FontSettings.tsx`（旧分支即未使用）
- `components/LabTrainingSidePanel.tsx`：**暂不删除**，等扩展协议决定；若要删，先确认
  教学包迁移计划。

每删一个先 `rg` 确认无引用（含 dynamic import / test），并跑对应测试。

### P2-2 响应式与可访问性回归

1. 360 / 768 / 1024 / 1440 四档截图：新抽屉、Quick 条、胶囊、文件工具栏、菜单。
2. 键盘：Tab 顺序、Esc、Enter/Space 触发、焦点可见环。
3. `prefers-reduced-motion`：抽屉/胶囊过渡降级。
4. `aria-label`/`title`：所有图标按钮必须有其一；关闭按钮触达区 ≥44。
5. 亮/暗主题：新面板无硬编码浅色背景/边框。

---

## 4. 建议执行批次

| 批次 | 内容 | 产出 |
| --- | --- | --- |
| B1 | `SideDrawer` + Plan/Subagents/Git 接入 | 三个抽屉统一、Esc/焦点/层级通过 |
| B2 | QuickTemplateBar 重做 + 位置合并 | composer 区只有一条上下文行 |
| B3 | 胶囊共存规则 + 计划卡/计划面板样式与 i18n | 右上角无重叠、计划面板可读 |
| B4 | 侧栏工具栏分组、quick tab、Git 入口规则 | 窄侧栏不挤、远程不占位 |
| B5 | 反馈行、EnvironmentsMenu/平台管理、远程 tab 徽标 | 细节一致 |
| B6 | 死组件清理 + 响应式/可访问性回归 | 无死代码、四档截图通过 |

每批单独 commit；不要和功能改动混在一起。

---

## 5. 必须保持绿的测试与验证

改 UI 时以下源级契约会直接比较 markup/字符串，**改结构要同步更新测试**：

```bash
# 目标批次
node --experimental-strip-types --test \
  components/SessionSidebar.project-tree.test.mjs \
  components/SessionSidebar.remote-files.test.mjs \
  components/ChatWindow.attach-files.test.mjs \
  components/MessageView.test.mjs \
  components/PlatformAdminDialog.test.mjs \
  components/FileViewer*.test.mjs \
  components/FileExplorer*.test.mjs \
  components/AppShell*.test.mjs \
  lib/i18n/registry.test.mjs \
  app/api/remotefs/*.test.mjs

# 类型与 i18n
npx tsc --noEmit
node scripts/i18n-normalize.mjs

# 全量（提交前）
npm test
```

特别注意：

- `SessionSidebar.remote-files.test.mjs` 断言
  `remote={activeFileTab.remote ?? null}`、`remote: input.remote ?? null`；
  改 FileViewer 传参方式要同步。
- `SessionSidebar.project-tree.test.mjs` 断言项目行创建参数、Quick 菜单、
  向导入口；改侧栏结构要保留这些语义。
- `ChatWindow.attach-files.test.mjs` 断言 `uploadChatFiles` 的 target 形式；
  改 composer/附件区不要回退。
- `watch-route.test.mjs` 断言远程 watch 事件名与轮询；改 SSE 协议要同步。
- i18n 三文件 key 集必须一致；英文 dot-key，禁止中文直键。

---

## 6. 交付物

1. 上述 B1–B6 的代码与截图（360/768/1024/1440，亮/暗各一组关键页面）。
2. 一份简短变更说明：哪些视觉规则被统一、哪些旧样式被删除、哪些文案改为 i18n。
3. 若发现功能语义需要改动（例如 Quick 条位置影响草稿切换），先在 PR 说明中标注，
   不要静默改行为。
