# pi-web 运行状态存储盘点与规范化建议

> 现状盘点（2026-11-19）。目标：减少“一坨 JSON 文件”带来的并发/一致性/迁移问题，
> 同时不破坏离线部署与现有备份方式。
>
> **更新（2026-11-19）**：下表是迁移前的路径盘点；Phase 1 的统一 `state/` 布局
> 已落地，核心 store 的新路径/信封/迁移策略见第 3 节。
>
> **更新（2026-11-20）**：User JSON 配置源（pi settings/MCP/models/auth/push）
> 已迁入 `state/users/u<id>`；会话/项目形态与删除级联见
> `docs/dev/session-project-model.md`。

## 1. 当前状态文件

| 文件/目录（`<dataDir>` 下） | 内容 | 作用域 | 备注 |
|---|---|---|---|
| `projects.json` | 项目记录（id/name/mode/owner/workdir/pins） | 全局单文件 | 全量重写；含远端真实 workdir |
| `session-metas.json` | 会话元数据（项目归属、标题、归档等） | 全局单文件 | 与 session JSONL 分离 |
| `sidebar-state/u<id>.json` | 项目/Host/会话置顶、未读 | 每用户 | 客户端偏好 |
| `host-dirs.json` | Host 目录注册表（root/name） | 全局 | 含服务器真实目录 |
| `quick-templates.json` | 快速会话模板 | 全局 | 管理员维护 |
| `server-settings.json` | 全局配置（公开地址/上传限制/镜像等） | 全局 | 含敏感配置 |
| `user-settings/u<id>.json` | 用户设置 diff | 每用户 | 默认模型/思考/工具等 |
| `user-config/u<id>/` | 用户级 skills/agents/mcp 等 | 每用户目录 | 文件即配置 |
| `user-models/u<id>/` | 用户级模型配置 | 每用户 | |
| `api-key-vault.json` | 平台 API key 明文保管 | 全局单文件 | 0600；产品取舍 |
| `web-sessions.json` | pi-web 登录会话 | 全局单文件 | 7 天滑动/90 天强制 |
| `mcp-quick.json` | 快速会话 MCP 覆盖 | 全局 | |
| `apkg-imports.json` | .apkg 导入计数 | 全局单文件 | 指纹 → count |
| `apkg-locked-homes.json` | 禁止再导出登记 | 全局单文件 | 项目 home → 指纹 |
| `apkg-recipient.json` | 接收方公钥元信息 | 全局 | 非私钥 |
| `config-bundles/` | 配置模板 zip/apkg + meta | 目录 | 含加密原件 |
| `projection/<projectId>/*.json` | 投影 manifest/status | 每项目 | |
| `session-images/` | MCP 图片资产 | 全局目录 | 无 TTL |
| `attachments/` | 聊天附件 | 每用户/会话 | 文件 |
| `batch-tasks/`、`batch-homes/` | 批量任务与临时 home | 目录 | |
| `locks/`、`logs/` | 锁与日志 | 目录 | |

会话正文仍是 Agent 目录下的 JSONL（不在 `dataDir`），图片/附件/工作区文件也是文件系统，
不应迁入数据库。

## 2. 主要问题

1. **无统一 schema/version**：每个 store 自己决定结构，升级靠零散迁移逻辑。
2. **路径与命名不统一**：`projects.json`、`session-metas.json` 是平铺文件，
   `sidebar-state/`、`user-settings/` 是按用户文件，`config-bundles/` 是目录。
3. **全量重写 + 多实例 mtime 缓存**：项目/会话元数据增长后每次写入成本上升，
   且多个 route 模块各持缓存，靠 mtime 对齐。
4. **无跨 store 事务**：删除项目要同时清 session-metas、pins、projection、home；
   中途失败会留下孤儿。
5. **无查询能力**：按 owner/project/时间过滤靠全量读入内存。
6. **备份/迁移各自为政**：升级包、回滚、导出没有统一的 state 快照。
7. **真实路径扩散**：`projects.json`/Host 注册表/会话元数据包含服务器或远端路径，
   前端/API 需要额外脱敏（本次已清理主要展示面，但数据结构仍保留）。

## 3. Phase 1：统一 JSON store（已落地 2026-11-19）

核心实现在 `lib/state/`：

- `paths.ts`：`global` / `user:<id>` / `project:<id>` scope 到目录的映射。
- `json-store.ts`：统一信封、原子写、`*.bak`、0600/0700、`proper-lockfile`
  跨进程写锁、mtime 缓存、旧文件懒迁移。
- 新文件格式：

  ```json
  { "schemaVersion": 1, "data": { } }
  ```

- 新目录：

  ```
  <dataDir>/state/global/*.json
  <dataDir>/state/users/u<id>/*.json
  <dataDir>/state/projects/<projectId>/*.json
  ```

- 首批迁移：`projects`、`session-metas`、`host-dirs`、`server-settings`、
  `quick-templates`、`api-key-vault`、`apkg-imports`、`apkg-locked-homes`、
  `config-bundles` metadata、`sidebar-state`、`user-settings`。
- 旧路径只读保留一个版本：首次读取时迁移到 `state/`，之后只写新路径；
  旧文件保留用于回滚/对照，下个版本删除。
- 写入前保留上一版 `<file>.bak`；目标损坏时依次回退 `.bak`、旧文件、默认值。
- 大文件/目录（sessions JSONL、images、attachments、bundle 原件、workspace
  homes、projection/sync-plan 目录）不进入 `state/`。

### Phase 2：复用平台后端（后续，不引入本地 SQLite）

pi-web 不再计划维护独立数据库。后续若要关系化/查询化，通过 `lib/state`
的 repository 适配层对接平台后端服务（平台 API 或平台直接管理的数据库），
而不是在 WebUI 侧新建第二个事实源。用户/认证仍以平台为准。

设计要点：
- 保留 `JsonStore` 作为默认实现；将来增加平台后端 adapter 时，业务代码只依赖
  `read/update` 接口。
- 平台侧只暴露必要的小型元数据（projects、session-metas、sidebar、settings 等），
  大对象和 append-only 会话正文继续留在文件系统。
- 不在 pi-web 内复制用户表或维护独立 auth 库。

### 选型注意

- 若将来确实需要本地缓存/离线兜底，再评估 `node:sqlite`；当前不引入。
- 无论适配哪种后端，先保持 Phase 1 的 repository 边界，业务层不动。

## 4. 后续顺序

1. 观察一个版本：确认 `state/` 迁移、锁、备份在真实部署无回归。
2. 下个版本删除旧 JSON 文件及旧读取回退。
3. 再评估平台后端 adapter；优先迁 `projects`、`sidebar`、`session-metas`、
   `shares`、`settings` 这类高频小数据。
