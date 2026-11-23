# 会话 / 项目模型规范（2026-11-23）

本文件记录 pi-web 的运行时分层、SessionDescriptor、项目形态、恢复与删除级联。
配置层见 [configuration.md](./configuration.md)，JSON 存储实现见
[state-storage-inventory.md](./state-storage-inventory.md)。

## 1. 分层

| 层 | 位置 | 内容 |
|---|---|---|
| Global | `<dataDir>/state/global/*.json`、`<agentDir>`、`<dataDir>` 全局目录 | 部署配置、项目/会话索引、全局资源 |
| User | `<dataDir>/state/users/u<id>/`、`user-config/u<id>/` | 偏好、sidebar、pi settings diff、MCP、models/auth、push、skills/agents/plugins |
| Project | `<projectHome>/.pi`、`<dataDir>/state/projects/<projectId>/` | 项目配置、projection/sync plan、项目状态 |

大对象不入 JSON state：会话 JSONL、图片、附件、bundle/apkg、workspace homes。

## 2. SessionDescriptor

```ts
interface SessionDescriptor {
  management: "webui" | "cli";
  projectId?: string;
  execution: "local" | "sandbox" | "relay" | "ssh";
  workspace: "managed-home" | "external-dir" | "scratch";
  profile?: "quick";
  ownerId: number;
  cwd?: string;          // SDK 会话 cwd（服务器侧）
  workspaceRoot?: string;// 工具/提示词的真实工作区
  templateId?: string;   // quick
  quickDir?: string;     // quick workspace 版本
}
```

- 持久化在 `session-metas` 的 `descriptor` 字段；旧会话按 `mode` 惰性推断。
- `descriptorToLegacyMode()` 只做 UI/API 兼容投影；新逻辑不再根据 `mode` 猜执行位置。
- 恢复、fork/branch/clone、子智能体、batch 均复制 descriptor；非 Host 会话缺项目、
  凭据、描述符或 Agent 兼容性时**失败关闭**。
- 运行时 registry 优先；重启后由 `session-metas` + 会话文件恢复归属。

## 3. 项目形态

| 形态 | ProjectRecord | execution | workspace | 说明 |
|---|---|---|---|---|
| 沙盒项目 | 有 | `sandbox` | `managed-home` | 工具进平台容器 |
| local-machine 项目 | 有 | `relay` | `managed-home` | 工具到配对机器 |
| SSH 项目 | 有 | `ssh` | `managed-home` | 工具到 SSH 主机 |
| WebUI Host 项目 | 有（admin） | `local` | `external-dir` | 服务器已有目录 |
| CLI/外部 Host 会话 | 无 | `local` | `external-dir` | Host(CLI) 页面 |
| Quick 项目 | 有 | `local` | `scratch` | 每 `(ownerId, templateId)` 一个 |

- WebUI Host 项目的 `workspaceRoot` 是外部目录；删除项目只删记录/状态，**绝不删目录**。
- Quick 项目按 `(owner,template)` 唯一；模板内容 hash 变化生成新 workspace 版本，
  旧会话保留自己的 `quickDir`。模板删除只标记 `templateMissing`，不清会话。
- Host/Quick 项目不支持“复制项目”语义。
- Host(CLI) 只显示没有 ProjectRecord 的 Host 会话；WebUI Host 项目归项目列表。

## 4. 会话空间

- 登录用户：`<agent sessions root>/users/u<id>/`。
- CLI/Host：`<agent sessions root>/`（Host 空间）。
- 管理员 WebUI Host 会话落在管理员自己的用户分片。
- 会话 id 解析必须通过空间围栏；跨用户访问统一 404。
- 删除会话时清理：meta、pins、shares、session images、fallback attachments；
  Quick workspace 不因单会话删除而误删（由项目/GC 管理）。

## 5. 恢复

- `restoreSessionOptions` 用 descriptor 重建工具层：sandbox/local relay/SSH/Host/Quick。
- SSH 无项目、sandbox 无平台凭据、local-machine 无配对/项目、project 不存在/不归属
  都返回 `SessionRestoreError`（409），不回落 Host。
- local-machine 恢复前校验项目 workspace MCP 配置安全（见 mcp.md）。
- 子智能体恢复继承父会话的 extension bridge 与 mode；不会变成服务器本地工具。
- 批量任务写 descriptor/meta，恢复时复用同一套 restore 路径。

## 6. 删除级联

### 项目

1. 路由先检查运行中的 RPC 会话/活动 batch 任务，冲突 409；检查与删除在项目写锁内。
2. 停止项目下的 idle/warm wrapper。
3. 删除项目 session JSONL、session metas、pins、session images、shares。
4. 删除 project pins、projection/sync plan、apkg locked-home、batch 记录/homes。
5. 删除 ProjectRecord 与 managed home；外部 Host 目录保留。

### 会话

- 删除 session JSONL、meta、pins、shares、images、fallback attachments；
- fork 子会话重新挂到父会话；
- Quick workspace 由项目/GC 管理。

### 用户

- 平台 DELETE 成功后：吊销 web session/vault/relay token/shares；
- 停止该用户全部 live wrapper（含 idle）；
- 取消该用户 active batch tasks（避免 runner 迟写复活）；
- 级联用户项目；
- 清理 state/user-config/homes/attachments/session JSONL；
- 外部 Host 目录保留。

## 7. 当前边界

- `web-sessions`、`shares`、`batch-tasks`、projection/status、sync-plans、
  embed-profiles、mcp-quick 仍有部分 store 未统一锁/GC。
- 平台侧直接删除/禁用用户不会实时推送；管理员操作会立即失效本地状态。
- Quick workspace、session images、attachments 的 retention/GC 仍在后续批次。
