# 运行状态存储盘点

> 状态：现行（2026-11-23）。描述 JSON state、不可变文件与大对象的边界、迁移与待办。
> 配置层语义见 [configuration.md](./configuration.md)，会话/项目模型见
> [session-project-model.md](./session-project-model.md)。

## 1. 存储原则

| 类别 | 位置 | 写入方式 |
|---|---|---|
| JSON 元数据 | `<dataDir>/state/` | JsonStore：信封、原子写、`.bak`、0600/0700、跨进程锁 |
| 会话正文 | pi agent sessions（用户分片/Host） | append-only JSONL |
| 项目配置 | `<projectHome>/.pi` | SDK/adapter 直接读取；项目写锁 |
| 大对象 | images/attachments/bundles/homes | 文件系统，不进 JSON state |

不引入本地 SQLite；未来若需要关系化查询，通过 repository 适配平台后端。

## 2. JSON state 布局

```
<dataDir>/state/
  global/
    projects.json
    session-metas.json
    host-dirs.json
    server-settings.json
    quick-templates.json
    api-key-vault.json
    apkg-imports.json
    apkg-locked-homes.json
    config-bundles.json
    ...
  users/u<id>/
    user-settings.json
    sidebar-state.json
    push.json
    pi/settings.json
    pi/mcp.json
    pi/models.json
    pi/auth.json
  projects/<projectId>/        # 预留/项目级小状态
```

统一信封：

```json
{ "schemaVersion": 1, "data": { } }
```

## 3. 核心实现

- `lib/state/paths.ts`：global/user/project scope → 路径；name/id 校验。
- `lib/state/json-store.ts`：读取缓存（mtime）、原子写、`.bak`、旧路径懒迁移、
  `proper-lockfile` 写锁、按路径失效。
- 旧文件只读保留一个版本；首次读取/写入迁移到 `state/`。
- 损坏文件回退顺序：`.bak` → 旧路径 → defaults。
- 删除后调用 `invalidateStatePathsUnder`，避免缓存读到旧值。

## 4. 仍未统一到 state 的 store

这些仍有独立文件/目录与缓存，属于 Batch 5：

| store | 现状 |
|---|---|
| `web-sessions` | 登录会话 JSON，滑动/绝对过期 |
| `shares` | `shares.json` + `share-files/` 快照 |
| `batch-tasks` | 每任务 JSON + 内存 registry/SSE buffer |
| `projection` | 每项目 manifest/status 目录 |
| `sync-plans` | 项目配置同步计划 |
| `embed-profiles` | 嵌入产品配置 |
| `mcp-quick` | 快速会话 MCP 覆盖 |
| `session-images` | 图片资产目录（无 TTL） |

后续目标：统一锁/原子写/跨进程可见性；明确 retention/GC；config-bundles 的元数据
与资产事务；平台身份外部删除的周期复查。

## 5. 会话与大对象

- 会话 JSONL 在 agent sessions root：用户分片 `users/u<id>/` 或 Host 空间。
- 图片/附件/分享快照/bundle/apkg/workspace homes 不进 state；删除级联需同时清理
  引用和文件。
- 工作区投影 manifest 只用于快速比较；截断/失败必须回退逐文件 stat，不能据此删除。

## 6. 并发与删除

- 项目配置写入/删除/会话启动使用项目读写锁；删除项目先检查运行中 RPC/批量任务。
- 项目级联：session JSONL、metas、pins、images、shares、projection、sync plans、
  apkg lock、batch、home（外部 Host 目录除外）。
- 用户删除：停 live wrapper、取消 active batch、级联项目、清 state/user-config/homes/
  attachments/session 空间、吊销 web/vault/relay。
- 所有删除幂等、best-effort；单个 rm 失败不阻断其余清理（Windows EPERM）。

## 7. 备份与迁移

- 包升级保留 `config/`、`data/`；`AMEDAC_HOME` 可整体搬迁。
- 平台 DB 与 pi-web state 分开备份；容器 overlay 另做一致性快照。
- 旧布局（user-config/user-settings/user-models、包内 data）懒迁移，旧文件保留可回滚。
- 会话 JSONL 与 state 的备份应保持同一时间点，避免 owner/project 元数据与正文不一致。

## 8. 后续顺序

1. 完成 Batch 5 的锁/GC/事务；
2. 观察一个版本后删除旧 JSON 兼容读取；
3. 再评估平台后端 repository adapter（projects/sidebar/session-metas/shares/settings）；
4. 不引入第二套本地数据库。
