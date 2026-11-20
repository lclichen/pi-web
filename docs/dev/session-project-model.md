# 会话 / 项目模型规范（2026-11-20）

本文件记录 pi-web 的运行时分层、会话描述符和项目形态。JSON 存储层规范见
`docs/dev/state-storage-inventory.md`。

## 1. 分层

| 层 | 位置 | 内容 |
|---|---|---|
| Global | `<dataDir>/state/global/*.json`、`~/.pi/agent`、`<dataDir>` 全局目录 | 部署配置、项目索引、会话索引、全局资源 |
| User | `<dataDir>/state/users/u<id>/` | Web 偏好、sidebar、pi settings diff、MCP、models/auth、push |
| Project | `<projectHome>/.pi`、`<dataDir>/projection|sync-plans/<projectId>` | 项目配置、projection、同步计划 |

大对象继续留在文件系统：会话 JSONL、图片、附件、bundle zip/apkg、workspace
homes。`state/users/u<id>` 只承载 JSON 配置源；`skills/agents/plugins` 仍是
`user-config/u<id>` 下的文件资源。

## 2. SessionDescriptor

```ts
interface SessionDescriptor {
  management: "webui" | "cli";
  projectId?: string;
  execution: "local" | "sandbox" | "relay" | "ssh";
  workspace: "managed-home" | "external-dir" | "scratch";
  profile?: "quick";
  ownerId: number;
  cwd?: string;
  workspaceRoot?: string;
  templateId?: string;
  quickDir?: string;
}
```

- 持久化在 `session-metas` 的 `descriptor` 字段；旧会话按 `mode` 惰性推断。
- `descriptorToLegacyMode()` 供旧 UI/API 投影，新逻辑不再用 `mode` 猜执行位置。
- 非 Host 会话缺项目、凭据或模式信息时明确失败，禁止回落 Host 本地执行。
- fork/branch/clone 复制 descriptor；batch 会话也写入 descriptor 和 meta。

## 3. 项目形态

| 形态 | ProjectRecord | execution | workspace |
|---|---|---|---|
| 沙箱项目 | 有 | `sandbox` | `managed-home` |
| local-machine 项目 | 有 | `relay` | `managed-home` |
| SSH 项目 | 有 | `ssh` | `managed-home` |
| WebUI Host 项目 | 有（管理员创建） | `local` | `external-dir` |
| CLI/外部 Host 会话 | 无 | `local` | `external-dir` |
| Quick 项目 | 有 | `local` | `scratch` |
| Quick 独立会话 | 有（自动归属项目） | `local` | `scratch` |

- WebUI Host 项目的 `workspaceRoot` 是服务器已有目录；删除项目只删记录和
  pi-web 状态，**绝不删除该目录**。Host/Quick 项目不支持复制。
- Quick Project 每个 `(ownerId, templateId)` 一个；模板内容 hash 变化生成新
  版本 workspace，旧会话保留自己的 `quickDir`。
- Quick 模板删除会给项目标记 `templateMissing`，不清空用户会话/工作区。
- Host(CLI) 页面只属于未托管的 Host 会话；WebUI Host 项目归项目列表。

## 4. 删除与恢复

- 项目删除：先检查运行中的 RPC/批量任务，冲突返回 409；随后清理 session
  meta、pins、projection、sync plans、apkg locked-home、批量任务记录/homes、
  session images；外部 Host 目录保留。
- 会话删除：清理 session meta、pins、来自该会话的 share、fallback attachments
  和 images；Quick workspace 由项目/GC 管理，不因单个会话删除而误删。
- 用户删除（平台 DELETE 成功后）：吊销本地 web session、vault、relay token、
  shares；停止 live RPC 会话；级联用户项目；清理 user state/user-config/
  homes/attachments/session JSONL；外部 Host 目录保留。
- 管理员禁用/改角色/重置密码用户：立即丢弃该用户的本地 web session，要求
  重新登录。

## 5. 仍待后续批次

- `web-sessions`、`shares`、`batch-tasks`、projection/status、sync-plans、
  embed-profiles、mcp-quick 的统一锁/原子写/跨进程可见性。
- batch/quick/images/attachments 的 retention/GC；config-bundles 资产+meta
  事务；update-status 路径统一。
- 平台身份在 pi-web 之外被删除/禁用时的周期性状态复查（当前由 pi-web 管理端
  操作触发本地失效）。
