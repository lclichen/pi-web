# 会话跨用户访问 与 远程模式工具桥接（调研 + 落地方案）

> 2026-10-29。回答两个运维/安全向问题：
> 1. 管理员打开普通用户的会话链接，现行行为是什么？应该怎么改？
> 2. 远程模式（sandbox/local-machine/ssh）里，内置工具之外的工具
>    （如 `bg_run`）为什么会在 Host 上执行？统一方案是什么？

---

## 一、管理员打开他人会话链接

### 1.1 现行行为（代码事实）

| 会话状态 | 普通用户打开他人链接 | 管理员打开他人链接 |
|---|---|---|
| 已落盘（未运行） | 404（`resolveSessionAccess` 路径栅栏） | **404**（栅栏只回退 host 空间，不进他人用户分片） |
| **运行中（live）** | **可读可写**（见下） | **可读可写**（同上） |

根因是"活会话快路径"绕过了 `resolveSessionAccess`：

- `app/api/agent/[id]/route.ts` POST：`if (existing?.isAlive()) return existing.send(body)`
  —— 直接投递 prompt/命令，**没有归属检查**；
- `app/api/sessions/[id]/route.ts` GET、`agent/[id]/events`（SSE）、
  `sessions/[id]/context`、`sessions/[id]/state`、`agent/[id]` GET：
  同样在 `getRpcSession(id)?.isAlive()` 时直接取注册表内容；
- 管理员侧栏与 `/api/agent/running` 对管理员返回**全部**运行中会话 id，
  所以管理员点进去即命中快路径（这解释了"打开链接直接看到内容"）。

结论：不是有意的"管理员可看"，而是 dev 多用户栅栏在局部漏掉了
registry 快路径（`lib/session-access.ts` 的注释写着管理员可为支持访问，
但落盘路径实际并不放行跨用户）。同时它对**普通用户**同样成立——任何
登录用户拿到一个运行中会话 id 就能读并能写，属于安全缺口。

### 1.2 已落地（本批）

- 新增 `checkLiveSessionAccess(req, sessionId)`（`lib/session-access.ts`）：
  活会话只允许 **owner 或 admin**；其他人 404（不泄露存在性）；无主
  wrapper（auth off / 遗留 host 会话）保持可达，不影响单用户部署。
- 接入全部 registry 快路径：`agent/[id]` POST+GET、`agent/[id]/events`、
  `sessions/[id]` GET、`sessions/[id]/context`、`sessions/[id]/state`。
  （`auto-name`、`git/review` 原本就走 `resolveSessionAccess`，已覆盖。）
- 行为不变项：管理员仍可打开他人**运行中**会话（支持场景），只是普通
  用户被挡住。

### 1.3 待决策：管理员的"支持视图"

管理员跨用户访问建议按"归属提示 + 只读"呈现，但这需要产品拍板：

- **只读的实现点不在 UI，而在写入口**：`POST /api/agent/[id]` 的
  `type: prompt / steer / set_model / abort …` 需要区分"观察"与"操作"。
  建议：对非本人会话默认拒绝所有**变更类**命令（prompt/steer/set_*），
  只放行 `get_state`/事件流；需要接管时由管理员显式确认（一次性开关）。
- UI：会话头部显示"归属：<username> · 只读"，与普通用户的"我的会话"
  视觉区分。
- 落盘会话（404）维持现状：不做"管理员可读所有历史"的入口，避免把
  "支持访问"扩张成"默认全可见"。

在拍板前，当前实现的安全边界是：**跨用户读写在活会话上仅限管理员**。

---

## 二、远程模式下的工具桥接（`bg_run` 在 Host 执行的根因）

### 2.1 现行机制

- 内置七件套（read/write/edit/bash/grep/find/ls）在远程模式由扩展**整体
  替换实现**（sandbox-tools / relay-tools / ssh-tools），路径参数经
  `toContainerPath` 映射，天然在目标工作区执行。
- 其它需要"进程/宿主能力"的工具走**通道注册**：`bg-shell` 扩展
  （pi-config/.../amedac-core/src/bg-shell.ts）在 `session_start` 里取
  `registry().channels.get(sessionId)`，取不到就 `localChannel(cwd)`。

### 2.2 泄漏路径（已确认）

1. **新会话从未注册通道**：`registerBgChannel` 原先只在
   `restoreSessionOptions`（恢复路径）与批处理里调用；`/api/agent/new`
   只注入模式扩展，没有通道注册。
2. **注册键错位**：`startRpcSession` 对新会话调用
   `SessionManager.create(...)`，SDK 自己生成会话 id；调用方传入的是
   `__new__<uuid>` 临时键。扩展在 `session_start` 用
   `ctx.sessionManager.getSessionId()` 查表 → 必然 miss。
3. **静默回退**：miss 时扩展直接选本地 spawn，`cwd` 是服务器侧
   合成 home（sandbox/local 模式）——命令在 pi-web 服务器上执行，
   对 sandbox 模式等于一次容器逃逸。

### 2.3 已落地（本批）

- 扩展：新增 `registerBgSessionMode(sessionId, "host" | "remote")`；
  bg_run **每次调用时**重新解析通道（不能只在 session_start 缓存，
  因为注册可能晚于 session_start）。`remote` 且无通道 → 返回明确错误
  （"后台任务通道未就绪…已拒绝本次调用"），**禁止本地回退**。
  pi CLI 不注册 mode，维持本地 spawn（语义不变）。
- pi-web：`RpcSessionStartOptions.bgChannel`；`startRpcSession` 在
  **真实 session id**（`inner.sessionId`）上注册 mode + channel。
  `/api/agent/new` 按模式构建通道：
  sandbox → `makeSandboxBgChannel`（无容器则只标 remote，调用时报错）；
  local-machine → `makeRelayBgChannel`；ssh → `makeSshBgChannel`。
  恢复路径继续注册，并补上 mode 标记。

### 2.4 统一方案（"模式通道化 + 禁止静默回退"）

`bg_run` 只是第一个案例。适用于所有"工具直接触达宿主 OS"的能力，
统一成三条规则：

1. **能力面声明**：会话启动时，模式方（pi-web）必须声明该会话的
   执行面（local / remote + 通道）。未声明 = 未受管（pi CLI），
   才允许本地执行。
2. **运行时解析，不缓存**：扩展在每次工具调用时解析通道，注册早/晚
   都正确（本次修复的实现）。
3. **失败显式化**：远程模式缺通道/通道报错 → 工具失败并给出原因，
   绝不降级到宿主。UI/模型侧看到的是"远端不可用"，而不是"在服务器
   上跑通了"。

落点清单（后续按此审计）：

| 能力 | 现状 | 结论 |
|---|---|---|
| bash/read/write/edit/grep/find/ls | 扩展整体替换 | 已通道化 |
| bg_run/bg_list/bg_stop | 通道注册 + 本次修复 | 已通道化 |
| relay/sandbox 自定义工具 | 各自实现（relay-tools/sandbox-tools） | 已通道化 |
| MCP 服务器 | 在 Host 进程内启动**是设计**（远端 MCP 需 SSH 隧道，未做） | 文档明示；模型提示词不承诺"远端执行" |
| 子代理 | 继承父会话扩展桥（`__piWebChildExtensions`） | 已通道化 |
| 未来新增工具 | 必须在模式 bundle 内实现或显式声明"仅 Host" | 评审项 |

### 2.5 验证建议（VM）

1. sandbox 会话（已绑定容器）跑 `bg_run "sleep 5; hostname"`：输出应
   是容器 hostname；`bg_stop` 后进程消失。
2. 同一会话在**容器未创建**时调用 `bg_run`：应得到"通道未就绪"错误，
   且服务器上无进程产生（`ps` 验证）。
3. local-machine 会话（agent 在线）`bg_run "pwd"`：应为用户机器工作区
   路径；agent 离线时应报 relay 错误。
4. 普通用户 A 拿用户 B 的运行中会话 id 调 `/api/sessions/<id>`、
   `/api/agent/<id>/events`：均应 404。
