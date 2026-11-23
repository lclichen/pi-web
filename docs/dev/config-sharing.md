# 配置包、预置模板与配置同步

> 状态：现行（2026-11-23）。覆盖项目配置包、管理员预置模板、Host 目录包、
> 工作区 `.pi` 同步与快速会话模板。配置层语义见 [configuration.md](./configuration.md)。

## 1. 项目配置包（导出/导入）

- 来源：项目 `.pi/**`、项目根 `AGENTS.md`、旧 `labs/**`（兼容保留）。
- 导出：项目菜单/目录菜单 → 下载 zip/apkg；凭证与运行态被剥离。
- 导入：目标项目上传 zip/apkg；先完整校验，再原子写入；叠加覆盖。
- 包内可含 `node_modules`（离线扩展依赖）；`.pi/.bundle-lock.json` 阻止重复导出。

安全闸门：

| 检查 | 行为 |
|---|---|
| 路径 | 只允许 `.pi/`、`labs/`；拒绝 `../`、绝对路径、symlink 逃逸 |
| 大小 | 总包 ≤200MB（可配），单文件限额 |
| schema | `mcp.json`/`models.json` 等按 adapter/SDK 结构严格校验 |
| 凭据 | `auth.json`、`ssh.json`、`sandbox-platform.json` 等永不进包 |
| stdio MCP | 普通用户禁止控制面 stdio；local-machine + plane=workspace 例外 |
| 工具模式 | 导入后当前模式不可用的 MCP 会被拒绝 |
| 信任 | 未信任项目的扩展/技能/MCP 先走项目信任 |

## 2. 预置配置模板（presetBundle）

管理员上传 zip 到 `data/config-bundles/<name>.zip`，普通用户新建项目时选择模板，
项目 home 创建时自动套用（seed 优先级最高）。

API/UI：

- `GET /api/bundles`：登录用户可列出（向导需要）。
- `POST /api/bundles`：管理员上传（multipart file/name/description）。
- `DELETE /api/bundles?name=…`：管理员删除（meta 同步清理）。
- 设置 → 配置模板：上传/列表/删除。
- 项目创建后：项目 ⋮ →“套用配置模板…”（叠加覆盖）。

## 3. Host 目录包

- Host 目录（管理员）有相同的导出/导入/套用模板菜单。
- Host 套用要求目标目录无 `.pi/`（避免覆盖现有配置，409）。
- 删除 Host 项目不删目录；配置包只操作 `.pi`。

## 4. 工作区 ↔ 项目配置同步

远端会话的 SDK 读取服务器项目 home 的 `.pi`；远端工作区里的 `.pi` 只是投影副本。
用户可在项目菜单执行“工作区 → 项目”同步：

1. 通过 WorkspaceOperations 收集 `.pi/**`（大小/深度/文件数上限）；
2. dry-run 展示新增/覆盖/跳过与 diff；
3. 校验 schema、凭证剥离、stdio/工具模式；
4. 备份后原子写入；失败回滚；
5. 标记 projection dirty，下一会话/提示词重投影。

反向（项目 → 工作区）由 projection 单向完成，不做后台双向合并。

## 5. 快速会话模板

Quick 模板（`data/quick-templates.json`）是轻量 JSON：系统提示词、模型、MCP 白名单。
它不参与项目配置包，也不落文件到用户工作区；Quick 项目按 `(owner,template)` 稳定。

## 6. 权限矩阵

| 操作 | 普通用户 | 管理员 |
|---|---|---|
| 导出/导入自己的项目 | ✅ | ✅ |
| 导出/导入 Host 目录 | ❌ | ✅ |
| 上传/删除预置模板 | ❌ | ✅ |
| 列出预置模板 | ✅ | ✅ |
| 套用模板到自己的项目 | ✅ | ✅ |
| 工作区配置同步 | ✅（自己的项目） | ✅ |

## 7. 已知边界

- 配置包无签名/版本校验，跨信任域分发需额外审计；apkg 有封条但边界见商业化文档。
- 包内 extension/MCP 仍会在项目会话执行；只信任来源明确的包。
- Host 目录无创建向导，创建时不能选模板（只能创建后套用）。
- 同步是显式动作；远端工作区不会自动改服务器配置。
- projection 的截断/失败回退、附件大文件分块、Apptainer bind 等边界见 ADR 0004。
