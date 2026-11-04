# 全局 / 用户 / 项目配置层级检视

> 2026-11-04。对象：`dev-0.85.1`（`8f368333`）。
> 目标：确认现有三层配置的边界，找出**本应属于个人、却被写到全局/项目/浏览器**的内容，
> 并给出可实施的用户层设计。

## 落地状态（2026-11-04）

已按确认后的边界实施：

- **pi 原生设置用户层**：`UserSettingsStorage`（全局 + 用户 diff）+
  `SettingsManager.fromStorage`；默认模型/思考、enabledModels、defaultTools
  等由用户会话写入用户层，管理员“常规”也是用户层，“全局配置”仍写全局。
- **常规设置**：PowerShell/工具开关写用户层；主题/语言/聊天宽度/字号/
  思考展开/引用选择通过 `/api/user-settings` 的 `ui` 持久化，AppShell 启动时
  从服务端恢复（localStorage 只做首屏缓存）。
- **用户 scope**：MCP、子智能体（两套 agents 服务）、Skills、Plugins/Extensions
  的安装/列表/运行时可选择 `user`，优先级为 **全局 < 用户 < 项目**；
  全局 scope 仅管理员；项目 scope 仍受 trust 门控。
- **Web Push**：VAPID 全局；订阅按用户文件；`notifySessionComplete` 只向
  session owner 的订阅推送。
- **按你的决定保持不变的**：项目 trust 全局共享；路径“不再询问”跟随项目；
  `.pi/web-preferences.json` 是工作区偏好；项目内单 MCP server 停用默认写
  项目 tombstone。
- **未做**：用户级快速模板/默认模板；用户级扩展的独立安全沙箱（目前用户
  扩展包复用全局 npm 根，仅按用户设置激活）；管理员“全局默认模型”的独立
  表单（全局默认仍可直接编辑 `~/.pi/agent/settings.json`）。

---

## 0. 结论

你的直觉是对的：**目前真正按“用户”持久化的，只有提问自动继续（`askAutoContinue`），
外加模型/凭据的用户层。** 其余绝大多数个人偏好要么写进全局 `~/.pi/agent/settings.json`，
要么写进项目 `.pi/web-preferences.json`（同项目所有用户共享），要么只存在浏览器
`localStorage`（换设备就丢）。

最需要纠正的不是“再加几个开关”，而是**缺一层通用的用户设置层**：

- pi 原生设置（默认模型/思考等级、enabledModels、defaultTools、steering/follow-up 等）
  目前由 `SettingsManager` 直接写全局 `settings.json`；
- Web 自己的偏好（MCP/子智能体开关、主题、语言、聊天字号、音效、工具预设…）
  分散在项目共享文件与 localStorage；
- 安全相关的个人决策（项目信任、路径“不再询问”）也是全局/项目共享；
- Web Push 订阅甚至放在全局 `web-push.json`，会跨用户推送。

建议按 **“部署策略 → 共享项目配置 → 个人偏好”** 重新划分，个人偏好用
`data/user-settings/u<id>.json` 承载，并支持按项目覆盖。

---

## 1. 现有层级盘点

### 1.1 五类存储

| 层 | 位置 | 当前内容 | 写入者 |
| --- | --- | --- | --- |
| 部署策略 | `data/server-settings.json` | labTraining、SkillHub URL、配置包上传上限、publicBaseUrl | 仅管理员 |
| 全局 Agent | `~/.pi/agent/` | `settings.json`、`models.json`、`auth.json`、`mcp.json`、skills/plugins/agents/prompts/themes、`trust.json`、`web-push.json` | 管理员 + 部分路由未做角色校验 |
| 项目 | `<cwd>/.pi/` | `settings.json`、`mcp.json`、extensions/skills/agents/prompts/themes、`path-policy*.json`、`ssh.json`、`web-preferences.json` | 项目所有者/管理员；trust 后加载 |
| 用户 | `data/user-settings/u<id>.json` | **只有 `askAutoContinue`** | 本人 |
| 用户模型 | `data/user-models/u<id>/{models,auth}.json` + `data/user-runtime/u<id>/` | 与全局不同的 provider/凭据；合并运行时 | 本人 |
| 浏览器 | `localStorage` | 主题、语言、聊天宽度/字号、音效、工具预设、引用选择、侧栏宽度、项目顺序、折叠、未读、引导进度、文件标签… | 当前浏览器 |

### 1.2 用户层的实际代码

- `lib/user-settings.ts`：`UserSettings` 只有 `askAutoContinue: boolean`，
  路径 `data/user-settings/u<id>.json`；注释明确说“与 workspace preferences、
  server settings 不同，属于一个登录”。
- `lib/user-models.ts`：模型/凭据用户层，已实现“只存与全局不同的 provider”
  的差量模式，可作为用户设置层的参考。
- 除此之外没有 `user-config`、`user-preferences`、`user-trust`、`user-push` 等目录。

---

## 2. 本应属于用户、但当前放错位置的内容

### 2.1 P0：会导致跨用户影响或安全边界错误

| # | 内容 | 现在写在哪 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **默认模型 / 默认思考等级** | 全局 `~/.pi/agent/settings.json` | 任一用户在新建会话时选模型/思考等级，`persistExplicitStartupPreferences()` 调 `SettingsManager.setDefaultModelAndProvider()` / `setDefaultThinkingLevel()`，SDK 直接写全局 settings。**一个人改，所有人默认值变** | 写用户层；全局默认仍由管理员显式设置 |
| 2 | **项目信任（trust）** | 全局 `~/.pi/agent/trust.json` | `ProjectTrustStore(agentDir)` 是全局文件；A 信任一个项目后，B 打开同一项目也直接执行其 `.pi/extensions`/MCP。信任是“我同意执行这段代码”，不能共享 | 每用户 trust store；auth-off/CLI 仍用全局 |
| 3 | **路径“不再询问”决策** | 项目 `.pi/path-policy.decisions.json` | A 选择“始终允许”后，B 的读写护栏也被放宽；决策是个人授权，不是项目策略 | 每用户决策文件；项目 `path-policy.json` 仍共享 |
| 4 | **Web Push 订阅** | 全局 `~/.pi/agent/web-push.json` | `notifySessionComplete(sessionId)` 向**所有订阅**推送；B 会收到 A 的会话完成通知（含会话名），隐私问题 | VAPID 密钥全局；订阅按用户分文件，按会话 owner 只推给本人 |
| 5 | **全局 skills / agents / tools 设置写入** | 全局 agentDir | `/api/skills/install`（global）、`/api/subagents/profiles`（global）、`/api/tools/settings` 没有管理员角色校验；普通登录用户可改所有人的全局技能/Agent/PowerShell 默认 | 全局 scope 加 admin gate；个人安装走用户层 |
| 6 | **`/api/preferences` 的 cwd** | 任意 cwd 的 `.pi/web-preferences.json` | 路由只校验 body 有 cwd，没有文件根/归属校验；登录用户可读写任意路径下的项目偏好文件 | 加 `resolveConfigCwd` / 文件根校验；并把内容迁到用户层 |

### 2.2 P1：个人偏好被共享或只存在浏览器

| # | 内容 | 现在写在哪 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 7 | **MCP 总开关 / 子智能体总开关 / labVerify** | 项目 `.pi/web-preferences.json` | 文件注释就写明 “shared by everyone in a cwd”；A 关掉 MCP，B 也没了 | 用户设置（可按项目覆盖）；项目文件降级为项目默认值 |
| 8 | **单个 MCP server 的启用/停用** | 默认写项目 `.pi/mcp.json` tombstone | 一个人停用某 server，项目里所有人都停用 | 用户级 disable 覆盖；项目 tombstone 作为项目策略 |
| 9 | **工具预设（default / read-only / chat-only）** | localStorage `pi-tool-preset` | 新会话/换浏览器回到默认；不是用户身份级 | 用户设置；项目可覆盖 |
| 10 | **enabledModels / 模型可见范围** | 全局或项目 `settings.json` | 普通用户不能维护自己的模型选择范围；全局修改影响所有人 | 用户 settings diff（SDK 设置层） |
| 11 | **defaultTools / PowerShell 开关** | 全局 `settings.json` | Windows 上一个人开关 PowerShell，所有人默认工具变 | 用户设置；管理员可设全局默认 |
| 12 | **主题 / 语言 / 聊天宽度 / 字号 / 音效 / 引用选择 / 思考展开** | localStorage | 换设备/换浏览器全部丢失；语言、主题是典型用户画像 | 用户设置；localStorage 只做本地缓存 |
| 13 | **未读标记 / 项目顺序 / 引导进度** | localStorage | 换设备丢失；未读和引导进度是“这个用户”的状态 | 用户设置；设备布局类保持本地 |
| 14 | **用户级 skills / agents / prompts** | 不存在 | 普通用户只能写全局（影响所有人）或项目（影响同项目所有人）；无法拥有“只属于我”的技能/Agent | 新增 `data/user-config/u<id>/{skills,agents,prompts}`；extension/plugin 仍限管理员/项目（执行代码风险） |

### 2.3 P2：可以后续再做

- 项目显示名/项目排序：如果项目记录本身是 owner 私有，放 ProjectRecord 即可；
  若未来共享项目，再升为用户+项目。
- 快速会话模板收藏/默认模板：目前模板是管理员全局配置；可加用户“默认模板”选择。
- 文件查看器打开的标签/滚动位置、侧栏宽度/分栏比例、最近自定义 cwd：
  这些是**设备布局**，建议继续 localStorage，不必上云。
- 消息反馈（`message-feedback` local store）：可保留本地。

---

## 3. 建议的目标层级

### 3.1 三类配置，不要混

| 类型 | 例子 | 谁可以改 | 优先级 |
| --- | --- | --- | --- |
| **部署策略** | 认证开关、publicBaseUrl、SkillHub、上传上限、全局模型/凭据、全局 MCP、labTraining | 管理员 | 最高，用户不可覆盖 |
| **共享项目配置** | 项目 `.pi/settings.json`、项目 MCP、项目扩展/技能/Agent、path-policy、SSH、环境 | 项目所有者/管理员，受 trust 门控 | 项目 > 用户 > 全局（对普通默认值） |
| **个人偏好** | 默认模型/思考、MCP/子智能体开关、主题/语言/字号/音效、工具预设、信任/路径决策、未读/引导 | 本人 | 用户 > 全局默认；项目可提供默认值/策略 |

### 3.2 关键 precedence 建议

- **模型/凭据**：保持现有 `全局 → 用户 → 项目`（项目最高）。
- **pi 原生设置**：同样 `全局 → 用户 diff → 项目 settings.json`。
  - 项目可以固定 `defaultModel` 等；用户默认值只在项目未设置时生效。
  - 用户对“本次会话”的显式选择仍是 session 级，最高。
- **Web 偏好**：`全局默认 → 用户 → 用户在该项目的覆盖`；项目 `.pi/web-preferences.json`
  降级为共享默认（可选），不再承载个人开关。
- **安全决策**：信任/路径授权**只有用户层**（auth-off/CLI 例外），项目不能替用户授权。

---

## 4. 用户设置 schema 建议

`data/user-settings/u<id>.json` 升到 v2，保留现有字段，未知字段原样保留：

```json
{
  "version": 2,
  "askAutoContinue": false,
  "defaults": {
    "model": { "provider": "anthropic", "modelId": "claude-sonnet-5" },
    "thinkingLevel": "high",
    "toolPreset": "default"
  },
  "tools": {
    "mcpEnabled": true,
    "subagentsEnabled": true,
    "labVerifyEnabled": true,
    "powerShell": false
  },
  "ui": {
    "locale": "zh-CN",
    "theme": "dark",
    "chatWidth": 820,
    "chatFontSize": 14,
    "soundEnabled": true,
    "quoteSelection": true,
    "thinkingExpanded": false
  },
  "onboarding": {
    "guideDone": true
  },
  "projects": {
    "<projectKey>": {
      "tools": { "mcpEnabled": false }
    }
  }
}
```

约定：

- `projectKey` 用 `workspaceKeyOf(cwd)`（与项目分组/记忆 key 一致），不要用绝对路径。
- 只存**差量**：与全局默认相同的值不写入，避免把全局配置快照进用户文件。
- 写入必须原子 + 0600；`getUserSettings` 的内存缓存按文件 mtime 或 PUT 失效。
- 不在用户文件里存 API key、provider 凭据（继续走 `user-models/u<id>/auth.json`）。
- 与 `user-models` 一样，管理员默认没有/只有空用户层；auth-off 用户 id 0 回落到全局。

---

## 5. 实施设计

### 5.1 通用 pi 设置用户层（最关键）

不要逐个字段打补丁；用 SDK 的 `SettingsManager.fromStorage()` 做一个
**用户设置存储适配器**：

```text
UserSettingsStorage(cwd, globalAgentDir, userSettingsPath)
  withLock("global", fn):
    merged = deepMerge(globalSettings.json, userDiff.json)
    next = fn(merged)
    userDiff = diff(globalSettings, next)   // 只写用户改过的键
    write userDiff
  withLock("project", fn):
    delegate to FileSettingsStorage(cwd, globalAgentDir) 的 project 写入
```

- `SettingsManager.fromStorage(storage, { projectTrusted })` → 传入
  `createAgentSessionServices({ settingsManager, agentDir: globalAgentDir, ... })`。
- `agentDir` 仍用全局，资源加载（skills/extensions/themes）不变；
  只有 settings 的全局读取被“全局 + 用户 diff”替代。
- `persistExplicitStartupPreferences()` 自然写用户层；
  不再出现“普通用户选模型 → 改全局默认”。
- 全局设置变化时，用户 diff 仍生效；`diff` 按 deep merge 语义（数组替换、对象递归）。
- 这个适配器同时覆盖：`defaultModel/defaultThinkingLevel`、`enabledModels`、
  `defaultTools`、`steeringMode/followUpMode`、`compaction/retry` 等所有 pi 设置。

> 注意：`SettingsManager` 的 `getGlobalSettings()` 在适配器下返回合并后的设置；
> 需要“真正的全局默认”时（管理员页面）走独立的全局读取，不要用用户 manager。

### 5.2 Web 偏好从项目文件迁到用户层

- 扩展 `user-settings` 的 `tools.*` 与 `projects.<key>.tools.*`。
- `/api/preferences` 改为：
  - 读：用户设置 → 项目 `web-preferences.json`（legacy 默认）→ 内置默认；
  - 写：写用户设置（或用户+项目覆盖），不再直接写项目共享文件。
- 首次升级迁移：项目 `web-preferences.json` 保留为项目默认，不清空；
  用户第一次修改时写用户层，自动覆盖。
- `SessionToolbar` / `McpServersConfig` / `SubagentsConfig` 的 toggle 走同一 API。

### 5.3 信任与路径决策按用户

- `ProjectTrustStore` 的 `agentDir` 换成每用户目录：
  `data/user-trust/u<id>/trust.json`（auth-off/CLI 用全局 `~/.pi/agent/trust.json`）。
- `getProjectTrustStatus(cwd, trustDir)` / `trustProject(cwd, trustDir)`
  的调用方按 session owner / 请求身份传 trustDir。
- 迁移：升级时把现有全局 trust 复制到每个已有用户目录（保留当前体验），
  之后各用户独立决策；新用户默认未信任。
- 路径决策：给 path-guard 增加“用户标识”来源——推荐在项目写一个
  `.pi/path-policy.identity.json`（`{ version: 1, userId }`，自保护、不导出），
  path-guard 读它把决策落到
  `.pi/path-policy.decisions.u<id>.json`；没有 identity 文件（CLI/auth-off）
  继续读写现有 `.pi/path-policy.decisions.json`。
- 项目 `path-policy.json`（策略）仍共享；只有“用户回答的决策”分人。

### 5.4 Web Push 按用户

- 全局 `web-push.json` 只保留 `vapidKeys`。
- 订阅拆到 `data/user-push/u<id>.json`；`notifySessionComplete(sessionId)` 先查
  `getRpcSessionOwner(sessionId)` / session meta 得到 ownerId，只向该用户订阅发送。
- auth-off / owner 0 仍用全局订阅，保持单用户行为。
- 订阅接口从请求身份取用户，不信任 body 里的 userId。

### 5.5 全局写入的 admin gate

- `/api/skills/install`：`scope !== "project"` 时要求 admin。
- `/api/subagents/profiles`：`scope === "global"` 时要求 admin。
- `/api/tools/settings`：改为写用户设置；如需全局默认，新增 admin-only
  “设为全局默认”动作。
- `/api/preferences`：加 `resolveConfigCwd` / `getAllowedFileRoots` 校验；
  普通用户只能写自己的用户设置或自己有权限的项目。
- 保持 `/api/plugins`、`/api/mcp` 现有 admin gate 不变。

### 5.6 用户级资源目录（可选，但建议）

- `data/user-config/u<id>/skills` → `additionalSkillPaths`；
- `data/user-config/u<id>/agents` → `listSubagentProfiles` 增加 user scope；
- `data/user-config/u<id>/prompts` → loader 的 prompt 路径（若 SDK 支持）；
- **不要**默认加载用户 extensions/plugins：它们执行代码，仍限管理员/项目 trust；
  如要支持，必须单独的用户扩展开关 + 明确风险提示。

### 5.7 UI 偏好同步

- 服务端用户设置作为 source of truth；localStorage 作为首屏缓存/离线回退。
- 迁移策略：首屏读到用户设置后覆盖本地缓存；未登录/auth-off 继续 localStorage。
- 保留设备本地：侧栏宽度、分栏比例、文件标签/滚动、最近 cwd。
- 可上云：locale、theme、chat width/font、sound、quote、tool preset、
  thinking expansion、guide progress、unread、project order。

---

## 6. 迁移顺序建议

### 阶段 1（P0，安全/正确性，约 3–5 人日）

1. `UserSettingsStorage` + `SettingsManager.fromStorage`，先接管
   `defaultModel/defaultThinkingLevel/defaultTools/enabledModels`。
2. `/api/skills/install`、`/api/subagents/profiles`、`/api/tools/settings` 的
   admin gate（或迁用户层）。
3. `/api/preferences` 的 cwd 校验 + 用户层读写。
4. per-user trust store（含迁移复制）。
5. path decisions 按用户。
6. Web Push 订阅按用户。

### 阶段 2（P1，体验，约 3–4 人日）

7. MCP/subagents/labVerify 开关与单 server disable 迁用户层。
8. UI 偏好上云（locale/theme/chat/sound/quote/tool preset/guide）。
9. 用户 skills/agents 目录。
10. 项目顺序/未读上云（或明确保持本地）。

### 阶段 3（P2）

11. 快速模板默认/收藏。
12. 共享项目的项目显示名/排序策略。
13. 用户扩展（需单独安全设计）。

---

## 7. 需要你确认的产品决策

1. **项目 trust 是否必须按用户？**
   推荐是。代价：同一项目每个用户首次打开都要确认；好处：不会替别人执行代码。
   如果希望“管理员信任一次，全员可用”，需要明确把它定义为项目策略而不是个人同意。
2. **用户默认模型 vs 项目默认模型谁优先？**
   推荐 `全局 < 用户 < 项目`（与模型层一致）；项目可固定模型，用户仍可在单会话显式改。
3. **MCP/子智能体开关是“用户全局”还是“用户+项目”？**
   推荐用户全局 + 允许按项目覆盖；项目 `.pi/web-preferences.json` 只作为 legacy 默认。
4. **用户能否安装自己的 skills/agents？**
   推荐 skills/agents 可以（纯提示词/工具选择），扩展/插件不可以（执行代码）。
5. **Web Push 是否只推给自己的会话？**
   推荐是；auth-off 单用户保持现状。

---

## 8. 相关文件索引

| 主题 | 文件 |
| --- | --- |
| 用户设置现状 | `lib/user-settings.ts`、`app/api/user-settings/route.ts` |
| 用户模型/凭据 | `lib/user-models.ts`、`app/api/models-config/route.ts` |
| 启动默认值 | `lib/startup-preferences.ts`、`lib/rpc-manager.ts`（`persistExplicitStartupPreferences` 调用处） |
| SDK 设置 | `node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js` |
| 项目共享偏好 | `lib/preferences-service.ts`、`app/api/preferences/route.ts` |
| 项目信任 | `lib/project-trust.ts`、`node_modules/.../trust-manager.js` |
| 路径决策 | `pi-config/agent/extensions/amedac-core/src/path-guard-policy.ts` |
| Web Push | `lib/web-push.ts` |
| 全局写路由 | `app/api/skills/install/route.ts`、`app/api/subagents/profiles/route.ts`、`app/api/tools/settings/route.ts` |
| 浏览器偏好 | `hooks/useI18n.tsx`、`hooks/useTheme.ts`、`hooks/useChatAppearance.ts`、`hooks/useAudio.ts`、`lib/tool-preset-preference.ts`、`components/ProjectSessionTree.tsx`、`components/SessionSidebar.tsx` |
| 部署设置 | `lib/server-settings.ts`、`components/AdminGlobalConfig.tsx` |
