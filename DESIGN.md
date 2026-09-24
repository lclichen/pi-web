# pi-web Design System

Portable design rules for AI-assisted UI work in this repository. 本文件面向
人类开发者与编码 agent（生成/修改 UI 前先读本文，不要自创视觉规则）。

与 ZCode 的 DESIGN.md（对照参考，见 `../harness-research/07`）不同，pi-web 没有
Tailwind/token 编译层——规范直接落在 **CSS 变量 + inline style 约定** 上。规则的目标
是：新增 UI 与存量 UI 视觉一致，主题（明/暗）切换零成本，中文界面不破版。

## 产品性格

pi-web 是**多用户、高信息密度的运营型 Web 工作台**（教学机房与团队共用部署），
不是营销页面。设计取向：

- 长会话、长列表、可扫读——密集优先于疏朗
- 冷静的中性色 + 单一 accent 强调，禁止渐变彩面与装饰性大圆角
- 桌面浏览器优先，移动端可用（抽屉化布局已有），不追求移动端华丽
- 三语言（en / zh-CN / zh-TW）文案长度差异不得破版

## 最高优先级约束（违反视为缺陷）

1. **颜色只用 `app/globals.css` 的语义变量**，禁止一次性色值（`color-mix(...)`
   派生现有变量除外，存量已有先例）。新语义色先加变量再使用。
2. **字号只用既有刻度**：10（徽标/极弱元数据）、11（次级元数据/等宽状态行）、
   12（辅助文本/排队行）、13（紧凑控件/终端）、14（正文，`--chat-content-font-size`
   可调）、16+（标题/弹窗头）。禁止 13.5、15 之类中间值。
3. **等宽字体只用于本质技术性内容**：路径、命令、哈希、模型 ID、终端、会话 ID。
   字体栈来自 `--font-mono`。
4. **inline style 是本仓现行惯例**，但状态色/尺寸/间距取值必须来自本文件刻度，
   不写魔法数。全局性规则（hover 展开等需要伪类的）进 `globals.css`，带注释。

## 色彩

### 语义变量（明/暗双主题由 `:root` / `html.dark` 定义）

| 变量 | 用途 | 禁止 |
|---|---|---|
| `--bg` / `--bg-panel` / `--bg-hover` / `--bg-selected` | 页面 → 面板 → 悬停 → 选中 的层级阶梯 | 混用层级制造无意义分区 |
| `--border` | 默认分隔线/描边 | — |
| `--text` / `--text-muted` / `--text-dim` | 正文 / 次要说明 / 弱提示（placeholder、禁用态相邻） | 用透明度模拟层级——直接换变量 |
| `--accent` / `--accent-hover` | 唯一强调色：主按钮、链接、激活态、引导类徽标 | 大面积填充；语义状态借强调色 |
| `--success` | 成功/在线/完成（需承载白字，用 600 档） | 装饰用途 |
| `--user-bg` / `--assistant-bg` / `--tool-bg` | 聊天消息与工具卡专属底色 | 挪作通用容器底色 |
| `--bg-subtle` | 极弱分区（列表斑马、内嵌块） | — |

### 语义状态色的固定 RGBA 约定（存量先例，新代码沿用）

错误 `239,68,68`（red-500 系）、警告 `234,179,8` + 文字 `rgba(180,130,0,…)`、
危险动作图标 `rgb(220,38,38)`。destructive 仅用于真实破坏性动作，禁止"响一点"。

### 强调色派生

边框/弱强调用 `color-mix(in srgb, var(--accent) 45%, transparent/var(--border))`
（排队徽标、聚焦环已有先例）；禁止新写死的蓝色色值。

## 字体

- UI 默认：系统 sans 栈（继承 body）。
- 等宽：`var(--font-mono)`（含中文回退 PingFang/微软雅黑）。
- 聊天正文宽度上限 `--chat-content-max-width: 820px`；字号 `--chat-content-font-size`
  （设置页可调，组件不得硬编码 14px 覆盖它）。
- 等宽状态行（ExtensionStatusBar 等）11px + `white-space: pre`。

## 间距与圆角

- 间距基数 4px；常用 4/6/8/10/12/16/20。flex 文本行内必加 `minWidth: 0` 配
  ellipsis 截断（存量约定）；嵌套滚动区加 `minHeight: 0`。
- 圆角刻度：**4**（行内小件/极小按钮）、**6**（输入框/小卡/横幅）、**7-8**
  （常规按钮/排队徽标容器/输入组）、**999**（胶囊徽标，仅用于 pill 形状）、
  大容器跟随既有面板值。禁止 10-11 这类无来由值；`rounded-full` 只给 pill。

## 组件约定

### 按钮

- 主按钮：`background: var(--accent)`，白字，禁用时 `var(--bg-panel)` + `--text-dim`。
- 次按钮：transparent + `1px solid var(--border)`，hover 换 `--bg-hover` 且边框可
  `color-mix` 提示（撤回按钮先例）。
- 图标按钮保持方形（width=height），title 必填（无障碍 + 无悬浮环境）。
- 破坏性图标按钮用固定红（见上）；操作层级靠排序与次按钮化，不滥用主按钮。

### 横幅/提示（ModelNoticeBanner、RetryBanner 先例）

`role="alert"`、`border: 1px solid rgba(语义色,0.3)`、`background: rgba(语义色,0.07)`、
12px、行高 1.45、`maxHeight` 限高滚动。通知条（notice）沿用 ChatWindow 既有样式。

### 排队/徽标行（QueuedMessageRow 先例）

10px 等宽徽标 + 胶囊边框（steer 用 accent 派生，follow-up 用 `--border`+`--text-dim`）；
文本 ellipsis 单行；行内操作按钮 hover 显示（globals.css `.queued-row-actions` 模式），
触屏 `@media (hover: none)` 常显。

### 输入区

流式期间双按钮语义色固定：引导=琥珀（`rgba(234,179,8,*)` 系）、排队=靛蓝
（`rgba(129,140,248,*)` 系）——存量既定，勿另配色。输入 shell 边框随模式变化
（bash 模式 `--tool-bg` 系）。

### 弹窗/管理面板

复用既有 Dialog 模式（见 AccountSettings / PlatformAdminDialog）：面板底 `--bg-panel`
或 Popover 层级、16px 内边距、12px 标题行 + 关闭按钮。八 tab 管理面板是密度基准。

## 动效

- `transition: background 0.12s, border-color 0.12s` 是交互反馈标准时长；禁止
  长弹簧动画。列表进入动画条目上限（ToolCallBlocks 先例：800 条定期清理）。
- 滚动跳转用锚定恢复（chat-scroll-position），不做平滑滚动炫技。

## 布局

- 三栏骨架（侧栏 / 会话 / 右侧面板）+ 底部终端抽屉，尺寸记忆走 panel-layout。
- 移动端：单栏 + 抽屉 + 底部工具条（AppShell.mobile-toolbar 先例），核心操作
  不得只在桌面可达。
- SSE 流式内容区禁用 transform 动画（性能）。

## i18n（强约束，违反即 bug）

- 键名 `域.名称`（如 `chat.queuedEditTitle`）；**en / zh-CN / zh-TW 三文件必须同键**
  （回退链 locale→en→key，缺键会裸露键名）。
- zh-TW 用台湾惯用语（佇列/儲存/滑鼠），不是简体直转。
- 文案带参数用 `{count}` 占位（format.ts）；快捷键提示注明平台差异先例见
  followUp 按钮（isMobile 分支）。

## 无障碍与测试

- 图标按钮 `title` 必填；交互 overlay 测试用 `data-testid` 惯例逐步补齐。
- 组件行为配 `*.test.mjs`（renderToStaticMarkup 断言优先）；视觉规范变化同步
  本文件，PR 里"改了样式没改 DESIGN.md"视为未完成。

## Do / Don't

- Do：语义变量、既有字号/间距/圆角刻度、等宽给技术值、`minWidth: 0` 截断、
  hover 展开操作、三语言同步。
- Don't：一次性色值/字号/圆角、透明度模拟文本层级、大面积 accent、装饰性动画、
  只在一种主题下调过的颜色、破坏 820px 阅读宽度的全宽长文。
