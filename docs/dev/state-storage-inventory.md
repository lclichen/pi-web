# pi-web 运行状态存储盘点与规范化建议

> 现状盘点（2026-11-19）。目标：减少“一坨 JSON 文件”带来的并发/一致性/迁移问题，
> 同时不破坏离线部署与现有备份方式。

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

## 3. 建议路线

### Phase 1：先规范化 JSON（低风险，建议先做）

- 新增 `lib/state/`：
  - `json-store.ts`：统一的 `{ schemaVersion, data }` 信封、原子写（temp+rename）、
    备份（`*.bak`）、读取校验、按 scope（global/user:<id>/project:<id>）定位。
  - 每个 store 一个模块，导出 typed repository（不直接读写路径）。
- 统一目录（可兼容旧路径读取）：
  ```
  <dataDir>/state/global/*.json
  <dataDir>/state/users/u<id>/*.json
  <dataDir>/state/projects/<projectId>/*.json
  ```
  大文件/目录（sessions JSONL、images、attachments、bundle 原件、workspace homes）
  继续留在文件系统。
- 暴露一个 `GET /api/admin/state/export`（admin）生成 zip 快照；
  升级脚本先备份再迁移。
- 迁移策略：启动时检测旧文件 → 读取 → 写新结构 → 保留旧文件只读一个版本 →
  下个版本删除。避免一次性破坏回滚。

### Phase 2：SQLite 承载小型元数据（可选）

Node 22 自带 `node:sqlite`（当前为 experimental，无 native 依赖），适合：
- `projects`、`session_metas`、`sidebar_pins`、`shares`、`host_dirs`、
  `quick_templates`、`server_settings`、`user_settings`、`apkg_imports`、
  `apkg_locked_homes`、`config_bundles` 元数据、`projection` 状态。

不建议进 DB：
- 会话 JSONL（append-only，已有成熟文件格式与工具）
- 图片/附件/工作区文件（大对象、需要直接文件访问）
- 配置包原件（zip/apkg 密文，保留文件便于下载/备份）

设计要点：
- 单文件 `state.sqlite` + WAL；每张表只存 id/owner/project/时间 + `data JSON`
  或少量高频列，先不追求完整关系模型。
- 一个 `Repository` 接口，JSON 与 SQLite 两套实现可切换（迁移期双读）。
- 事务覆盖“删除项目”这类跨表操作；置顶/未读用 `(user_id, key, rank)` 表。
- **用户/认证不要迁入**：用户系统在平台侧，pi-web 只做会话代理；
  离线单用户模式也没有多用户表需求。把 auth 复制进 pi-web DB 会制造第二事实源。

### 选型注意

- `node:sqlite` 目前有 experimental 警告，且 Next 服务端打包需确认 external；
  若要求长期稳定，`better-sqlite3` 更成熟但引入 native 模块，离线安装/多平台
  发布成本更高。
- 无论哪种，先做 Phase 1 的 repository 抽象；这样 Phase 2 只换实现，不动业务。

## 4. 建议顺序

1. 本次先修项目信任/路径脱敏/信任刷新/新建项目置顶/投影 dirty（已做）。
2. Phase 1 统一 JSON store + state 导出/备份。
3. 观察一个版本后，再决定是否上 SQLite；优先迁 `projects`、`sidebar`、
   `session-metas`、`shares`、`settings` 这几类高频小数据。
