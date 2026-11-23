# Sandbox Platform 集成与运维

> 状态：现行（2026-11-23）。Sandbox Platform 位于独立仓库
> `AgentSandbox/sandbox-platform`；本文是 pi-web 框架视角的整合文档。完整 API/ADR/运维
> 手册以该仓库源文档为准（见文末）。

## 1. 职责

Sandbox Platform 是沙盒执行面的控制与数据服务：

- 平台账号、JWT/API key、角色、注册/审批/强制改密
- 资源配额（容器数/CPU/内存/磁盘/镜像白名单）
- 容器生命周期（Apptainer/SSH/Mock executor）
- 持久 overlay、快照、workspace/云盘、文件 API
- 容器内工具 API（read/write/edit/bash/grep/find/ls）
- PTY WebSocket
- 审计日志、管理面板 API、健康/指标
- 可选 LiteLLM 网关（默认关闭）

pi-web 不自己维护用户表或容器；平台是账号与容器资源的唯一事实源。

## 2. 端口与部署

默认：

- `:3000` 平台 REST/PTY/健康检查
- WebUI `:30141` 由 pi-web 提供，服务端代理登录与平台调用
- 生产建议平台只监听 127.0.0.1，由反向代理/TLS 暴露 WebUI

执行器：

| `EXECUTOR_KIND` | 说明 |
|---|---|
| `apptainer-cli` | 同机 Apptainer（离线包默认可用时） |
| `ssh` | 远端执行节点（生产常用） |
| `mock` | 无隔离本地 shell，仅开发/测试；生产拒绝 |
| `auto` | 启动时探测，失败则拒绝启动（不静默降级 mock） |

数据库：`sqlite`（开发/小部署）或 `postgresql`（生产）；启动自动幂等迁移。

## 3. 认证与身份

- `POST /api/v1/auth/login` 返回 `accessToken`/`refreshToken`/`user`；JWT 15 分钟，
  refresh 轮换。
- API key `sk_...` 通过 `X-API-Key` 或 `Authorization: Bearer`，长期有效，可吊销。
- pi-web 登录代理：用户登录后服务端保存/铸造平台 API key，浏览器不接触。
- 普通用户跨用户资源统一 404；admin 端点 403。
- 注册：`REGISTER_MODE=off|open|approval`；审批队列/CSV 导入。
- 强制改密：`must_change_password` → `403 PASSWORD_CHANGE_REQUIRED`。

## 4. 容器与配额

- `POST /containers` 检查：
  1. `images.allowed_image_ids`（配额白名单）
  2. 配额 `max_containers/cpu/mem/disk`
  3. `images.max_per_user`
- 超限错误带稳定 `code`（如 `QUOTA_EXCEEDED`/`IMAGE_NOT_ALLOWED`）。
- 容器 owner 隔离；一个容器同一时间只绑定一个项目（pi-web 侧保证）。
- 停止/启动/连接/删除；快照（overlay 拷贝）与恢复；FIFO 保留策略。
- workspace：用户级云盘，新建容器可 seed；容器内改动不会后台自动回写，需显式导出。

## 5. 工具 API（pi-web sandbox 模式）

pi-web 注入 amedac-core 的 sandbox tools，工具调用打到平台：

| 工具 | 平台端点 |
|---|---|
| read | `POST /containers/:id/tools/read` |
| write/edit | `.../tools/write` |
| bash | `.../tools/bash`；流式 `.../bash/stream` |
| grep/find | `.../tools/grep`、`/find` |
| ls/stat/access | `.../tools/ls|stat|access` |

请求带项目 `.pi/sandbox-platform.json` 的 `url/apiKey/containerId`；`disableLocalFallback`
强制为 true。平台不可用时失败关闭，不回落服务器本地。

## 6. PTY

- `GET /api/v1/containers/:id/pty` WebSocket，桥接
  `apptainer exec instance://<id> bash`。
- 帧协议：input/output/resize/exit；每容器并发上限（默认 3），泄漏订阅 60s 回收，
  30min idle 清扫 + ping。
- pi-web 只做 SSE 代理，不直连容器。

## 7. pi-web 集成契约

| 能力 | 契约 |
|---|---|
| 登录/BFF | `/auth/login`、`/auth/me`、API key |
| 容器选择 | `GET /containers?filter=running&image=`；`GET /provision/defaults` |
| 项目绑定 | 项目 `.pi/sandbox-platform.json` 保存 containerId |
| 工具 | `/tools/*`，错误码透传 |
| 文件面板 | workspace/tools 读/写；媒体用 binary 读取 |
| 终端 | PTY WS |
| 管理面板 | pi-web admin API 代理平台 admin 端点 |
| 健康 | `/health`、`/ready`、`/metrics` |

稳定错误码、SSE 语义、单实例限制见平台 `docs/API-REFERENCE.md`；集成需求见
`docs/PI-WEB-INTEGRATION-REQUIREMENTS.md`。

## 8. LLM 网关（可选）

- 默认 `LLM_ENABLED=false`：所有 `/api/v1/*llm*` 返回 `501 LLM_NOT_ENABLED`，容器不注入
  `SANDBOX_LLM_*`。
- 启用时由平台管理绑定/虚拟 key/预算；pi-web 模型配置与网关是两套，不要混用。
- 生产不建议把平台 LLM key 暴露给容器外进程。

## 9. 备份/迁移/升级

- `npm run backup` / `restore` / `migrate-db` 支持 sqlite ↔ postgresql。
- 升级保留 `config/` 与 `data/`（tar 包排除）；数据库迁移幂等。
- 容器 overlay 与包目录分离；备份要同时覆盖平台 DB 与 Apptainer 数据目录。
- 监控：`/metrics` Prometheus；审计日志 `operation_logs`。

## 10. 已知边界

- `mock` 执行器无隔离，仅开发测试；生产 fail-closed。
- PTY 依赖 node-pty 原生绑定；glibc 2.17 需专门构建。
- 平台管理 SPA 已移除，管理界面统一在 pi-web 管理面板。
- 平台账号在 pi-web 之外删除时，pi-web 本地会话失效依赖管理端触发/401 复查。
- LLM 网关是可选组件；关闭时容器内无模型凭据。

## 11. 源文档

- `AgentSandbox/sandbox-platform/README.md`
- `AgentSandbox/sandbox-platform/docs/API-REFERENCE.md`
- `AgentSandbox/sandbox-platform/docs/DEPLOYMENT.md`
- `AgentSandbox/sandbox-platform/docs/USER-GUIDE.md`
- `AgentSandbox/sandbox-platform/docs/ADR.md`
- `AgentSandbox/sandbox-platform/docs/项目架构图.md`
- `AgentSandbox/sandbox-platform/docs/Apptainer轻量用户手册.md`
