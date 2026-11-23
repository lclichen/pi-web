# 多用户与执行模式

> 状态：现行（2026-11-23）。描述平台账号、会话归属、五种 WebUI 执行模式、权限矩阵
> 与配额。总体架构见 [PLATFORM.md](./PLATFORM.md)，会话/项目字段见
> [session-project-model.md](./session-project-model.md)。

## 1. 目标

1. **多用户**：账号、登录态、管理员/普通用户角色、数据隔离。
2. **多执行模式**：同一套 WebUI 和 Agent 运行时，工具可以落到平台容器、用户本机、
   SSH 主机或服务器本地。
3. **可恢复**：会话重启、fork、fork_branch、clone、子智能体、批量任务都保留正确的
   执行模式；缺上下文时失败关闭，绝不误用服务器本地工具。
4. **可运维**：登录、项目、会话、配置、文件、终端、MCP、批量任务的边界都在服务端
   校验，浏览器不持有平台令牌。

## 2. 账号与登录

平台账号以 **sandbox-platform** 为唯一事实源。

- `POST /api/webauth/login` 代理平台 `/api/v1/auth/login`；成功后 pi-web 建立
  HttpOnly 会话 cookie，服务端保存平台 API key/refresh 凭据，浏览器看不到 token。
- 普通用户与管理员来自平台角色；`PI_WEB_AUTH=off` 时是单用户兼容模式（隐式 host admin）。
- 登录会话：滑动空闲窗口默认 7 天、绝对上限 90 天；服务端按用户保存多会话，
  不因另一个窗口登录而互踢。
- 管理员禁用/改角色/重置密码后，pi-web 丢弃该用户的本地 Web 会话，要求重新登录。
- 平台账号删除后，pi-web 管理端会级联清理本地相对状态（登录、vault、relay token、
  项目、会话、home、附件、batch 等）；外部 Host 目录不删。

## 3. 会话空间与归属

```
<agent sessions root>/                 Host 空间（CLI 创建 / 隐式 host）
<agent sessions root>/users/u<id>/     登录用户的会话分片
```

- WebUI 的 sandbox / local-machine / SSH / Quick 会话落在用户分片；管理员 WebUI Host
  会话也落在管理员自己的分片。
- CLI 会话写在 Host 空间，不感知 Web 登录；管理员可在 Host(CLI) 页面查看。
- 读取/写入/SSE/终端等路由都做空间路径围栏 + owner 检查；跨用户统一 404。
- 运行时注册表优先（`globalThis.__piSessions`），`session-metas` 是持久 sidecar；
  重启后由 sidecar + 会话文件恢复归属。
- 管理员可以查看他人的会话用于支持，但 UI 明确标记归属；普通用户不可见。

## 4. 五种 WebUI 执行模式

| 模式 | 可用者 | Agent 进程 | 工具执行位置 | 工作区 | 文件/终端 |
|---|---|---|---|---|---|
| **sandbox** | 登录用户 | pi-web | 平台容器 `/workspace` | managed-home + 容器 | 平台 tools/PTY |
| **local-machine** | 登录用户（需配对 Agent） | pi-web | 用户自己的机器 | managed-home + 远端 workdir | relay fs/exec/pty |
| **ssh** | 登录用户（项目有 ssh.json） | pi-web | SSH 主机 | managed-home + 远端 workdir | ssh2 SFTP/exec/PTY |
| **host** | 管理员 | pi-web | pi-web 服务器 | external-dir | 服务器本地 |
| **quick** | 登录用户 | pi-web | pi-web 服务器（scratch） | scratch | 受控工具集，无用户工作区 |

补充：

- **CLI Host** 不是 WebUI 模式：CLI 创建、无 ProjectRecord、external-dir，仅管理员可见。
- Quick 不是“无项目”：每个 `(ownerId, templateId)` 有一个稳定 Quick Project；
  模板内容变化生成新 workspace 版本，旧会话保留自己的 `quickDir`。
- 模式是会话创建时决定的，运行中不切换；恢复时以 descriptor 为准。

## 5. 项目与 workspace

| 形态 | ProjectRecord | execution | workspace | 删除行为 |
|---|---|---|---|---|
| 沙盒 | 有 | sandbox | managed-home | 删 home/容器绑定/sidecar；容器按平台策略处理 |
| 本机 | 有 | relay | managed-home | 删服务器 home/sidecar；用户机器目录不动 |
| SSH | 有 | ssh | managed-home | 删 home/sidecar；远端目录不动 |
| WebUI Host | 有（admin） | local | external-dir | 只删记录/状态，**目录保留** |
| Quick | 有 | local | scratch | 删当前版本 workspace；模板缺失只标记 |
| CLI Host | 无 | local | external-dir | 跟随会话删除 |

- ProjectRecord 保存 id/name/owner/mode/execution/workspace/container/machine/ssh 等。
- `publicProject` 不返回服务器/远端真实路径；前端只展示项目名和公开字段。
- 项目删除前检查运行中的 RPC 会话/批量任务；冲突返回 409。删除级联见
  [session-project-model.md](./session-project-model.md)。

## 6. 权限矩阵

| 能力 | 普通用户 | 管理员 |
|---|---|---|
| 创建沙盒/本机/SSH/Quick 会话 | ✅（本机需配对，SSH 需项目凭据） | ✅ |
| 创建 WebUI Host 项目/会话 | ❌ | ✅ |
| 查看 Host(CLI) 会话 | ❌ | ✅ |
| 查看他人会话 | ❌（404） | ✅（支持视图） |
| 全局配置/模型/MCP/凭据 | ❌ | ✅ |
| 用户级配置 | ✅（仅自己） | ✅（可管理他人层） |
| 项目配置（自己的项目） | ✅（受信任/写锁约束） | ✅ |
| 项目级 stdio MCP（控制面） | ❌ | ✅（`plane=host`） |
| local-machine workspace stdio MCP | ✅（project scope） | ✅ |
| 删除用户/平台资源 | ❌ | ✅ |

## 7. 配额与准入

- `lib/rpc-manager.ts` 的 `checkRpcSessionQuota` 限制每用户/全局活动 RPC 会话数；
  管理员只豁免每用户上限，不豁免全局上限。
- 批量任务 API 有每用户并发上限（默认 4，含排队；管理员豁免），任务归属隔离。
- 沙盒容器配额由平台 `resource_quotas` + `images.max_per_user` 双重检查。
- 登录/注册/PTY/LLM reveal 等平台端点有独立限流；pi-web 登录代理再加一道。
- 项目删除、配置写入、会话启动通过项目配置读写锁避免 TOCTOU。

## 8. 配置分层

- **Global**：管理员默认（agentDir、state/global、全局 model/MCP/skills/plugins）。
- **User**：`state/users/u<id>/` 的 JSON 配置 + `user-config/u<id>/{skills,agents,plugins}`。
- **Project**：`<projectHome>/.pi`，SDK/adapter 直接读取；远端工作区有投影副本。
- 优先级：Global < User < Project；模型/凭据、MCP、Agents、Skills、Plugins 均按层合并。
- 路径决策、项目信任、web-preferences 保持项目级；side bar 置顶/未读是用户级。

详见 [configuration.md](./configuration.md)。

## 9. 安全不变量

1. 浏览器不接触平台 API key、Agent token、项目凭据。
2. 任何远程会话缺项目、凭据、descriptor 或 Agent 兼容性时**拒绝启动**，不回落到
   Host 本地工具。
3. 普通用户的项目 stdio MCP 禁止在控制面执行；只有 local-machine + project scope +
   `piWeb.plane="workspace"` 允许由 Agent 托管。
4. 远端工作区路径必须经过 workspace base/路径围栏；bash 的路径护栏是行为护栏，
   不是强隔离边界。
5. 项目配置包导入/同步受 schema、凭证剥离、项目信任和工具模式检查约束。

## 10. 已知边界

- 单 Node 进程托管所有 Agent 会话；高并发需要 worker/多进程执行面。
- 平台侧用户状态在 pi-web 之外变化（直接删库/禁用）目前依赖管理端操作触发本地失效，
  周期性复查仍待补。
- sandbox/SSH 的 workspace-plane MCP 尚未实现；local-machine 已支持 stdio。
- Windows Agent 的 PTY 仍是桩实现（终端不可用）；Linux/macOS 正常。
- 路径护栏对解释器脚本、MCP 内部文件操作和变量展开只能 best-effort。
