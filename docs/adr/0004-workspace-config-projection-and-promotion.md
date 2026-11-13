# 0004 — 工作区配置投影与晋升（修订版）

状态：Proposed（替代 2026-11-13 的聊天草案）
日期：2026-11-13
关联提交：`ec2f2fec`（工作区→项目配置同步）、`7f43b706`（附件 Host 主存/远端镜像 + 原子写）
关联文档：AGENTS.md（架构）、agent/README.md（relay 协议与安全模型）、docs/dev/attachment notes

本文是在原草案基础上、按当前代码实测结果修订的可落地版本。原草案的方向正确（控制面驻留
Host、按子树声明所有权、显式上行），但有若干前提与当前状态不一致，且遗漏了“选择性收取”
这条用户明确选择的上行通道。下面先列差异，再给完整方案。

## 0. 与原草案的关键差异

| 原草案 | 当前实际状态 | 修订 |
|---|---|---|
| §0：Apptainer 默认挂载 home/tmp/cwd，项目区今天可被沙盒读写，投影上线前必须收紧 | 平台两个 executor 已经使用 `--contain --no-mount hostfs,cwd`，只显式 `--bind` 工作区种子/输入输出目录（`apptainer-cli-executor.ts:36-42`、`ssh-executor.ts:184`）；项目 home 不在 bind 列表 | **不再是阻塞前置**；保留一个容器内回归探针，防止未来改坏 |
| 下行投影需要 Go `fs.manifest` + hello `projection-v1` | `WorkspaceOperations.writeFile` 契约已接受 `string | Uint8Array`；host/sandbox 已支持字节，relay/SSH 仍显式拒绝非字符串；`fs.manifest`/`projection-v1` 不存在，agent 当前 0.6.0 | v1 **不新增 agent 协议**：先补 relay/SSH provider 的字节写，投影用 `readdir/stat/readFile/writeFile`；`fs.manifest` 降为 P2 性能优化 |
| workspaceId：relay=machineId、SSH=host+workdir、sandbox=containerId | 项目当前绑定一个活动工作区（`project.workdir` / `machineId` / `containerId`）；container/workdir 可被修改；同一 container 可被多个项目绑定 | 用 `mode + root + backend` 的 composite key；改工作区即新 key；明确“一个项目一个活动工作区”的假设 |
| manifest 有自增 `epoch` | 没有 Host 侧 project epoch；多进程/重启会竞争 | 去掉计数器；用 `hostDigest = sha256(sorted(rel:hash))` 作为内容版本 |
| plan 缓存：内存 LRU 8 条 × 64MB | 单条最多 64MB，8 条最坏 512MB，VM 只有 8GB | 落盘 `<dataDir>/sync-plans/<token>/`，只缓存**变更写**（baseline 覆盖全量 collected 的 hash），总量上限 128MB，一次性消费 |
| 上行白名单沿用 `assertAllowedConfigPath` / `isDeniedConfigPath`；attachments 与 backups 需确认不在白名单 | `isDeniedConfigPath` 已排除 `.pi/attachments`；`.sync-backups` 未在任何 deny 清单；path guard 仍允许 agent 写 `.pi/attachments` | 补 `.sync-backups` 到 bundle deny + path guard 自保护；attachments 加 `denyWrite`（读允许）；补充测试 |
| attachments 只读缓存、自愈覆盖 | 聊天上传在 Host 先原子写、再远端镜像；文件名图片唯一、普通文件保留原名并用 `conflict=skip`；Host 清理只删 Host | 统一聊天附件唯一命名；保留上传时快路径；投影负责补推/漂移修复/**Host 删除传播**；path guard 拒绝 agent 写 attachments |
| 交付物收取（用户明确选择“选择性收取”）在最终 ADR 中没有落地 | 工作区产物目前只能靠文件浏览器下载 | 增加 P2 选择性收取：工作区 `artifacts/` → Host 收集库，用户多选触发，独立 API/UI，不进配置闸门 |
| 多文件 apply：先全部 temp 再逐个 rename，失败回退 | 逐文件 rename 无法提供跨文件原子性；运行中的 loader 可能看到混合版本 | 明确为“逐文件原子 + 项目空闲闸门”；apply 时若项目有运行中会话**或 batch 任务**则 409 |
| 晋升后“loader 重载” | SDK `reload()` 存在，RPC `reload` 命令已接；但 sync apply 没有触发任何 reload | apply 后对项目内空闲会话 fan-out reload；运行中的会话标记 `reloadOnIdle`（仅内存，restore 兜底） |
| `models.json` 开放问题 | 当前 sync 会 schema 校验后写入项目 home | **已拍板：完全不参与 sync**（不是默认跳过）；模型配置只走 UI |
| 多工作区并发“下行只读扇出天然安全” | 当前同步 API 只按 projectId 解析唯一工作区，没有 workspace 选择器；多工作区只在改 workdir/machine/container 时出现 | **已拍板：近期不做并发多工作区**；v1 按“一个项目一个活动工作区”实现，并加不变式测试 |

### 0.1 二审修正（2026-11-13，按实际代码复核）

以下问题已确认并纳入正文，不是文档笔误：

1. **baseline 必须覆盖全量 collected（P0）**：plan 缓存只存变更写，但 apply 的最终配置 =
   缓存写 + home 未变化文件；未变化文件在预览后被改会绕过校验。`homeBaseline` 覆盖
   collect 的每个 rel（存在→hash，不存在→null），apply 全量比对；不缓存全量内容。
2. **PROJECT_BUSY 必须看见 batch（P0）**：batch 的 `startRpcSession` 虽在 registry，
   但 wrapper 没有 projectId，按项目过滤会漏；给 `RpcSessionStartOptions`/wrapper 加
   projectId，并把 batch task registry 的 running 任务并入 busy 判定。所有 project-home
   配置写路径共用 `project-config-lock`（sync/bundle apply/settings/models/MCP/sandbox）。
3. **GC/换 key 竞态（P0）**：workspaceKey 用 canonical root；manifest 记 canonical root；
   key 变化但 canonical 相同 → 继承 manifest；reconcile 与 GC 共用 per-key 锁，GC 跳过
   在途 key；reconcile 开始/结束校验 root 未变。
4. **hostDigest 的 stat 缓存（P1）**：digest 仍由内容 sha256 合成，但 Host 侧维护
   `(rel,size,mtimeNs,ino)->sha256` 缓存；命中不读文件；temp+rename/git checkout 只导致
   一次重算，不会每回合假 dirty。可复用 session-list-scanner 的 fingerprint index 思路。
5. **attachments 弱判定（P1）**：size+mtimeNs 只是快路径；增加周期性全量 hash
   （默认 10 分钟或每 N 次 reconcile）与 repair 强制全量；状态记 `lastVerifiedAt`；
   文档不声称绝对自愈。
6. **reloadOnIdle 生命周期（P1）**：标记只存 wrapper 内存，不持久化；驱逐/重启靠 restore
   自然加载新配置；fan-out reload 走 per-session start lock，跳过正在 restore/streaming
   的会话；reload 失败清标记并在状态里报告。
7. **rollback × 投影（P1）**：rollback 返回 `projection.needsDiscard`；UI 明示“项目区已
   回退，工作区有本地修改需丢弃后才生效”，并提供一键 `repair {all:true}`；可选
   `discardWorkspaceChanges:true` 让用户显式选择强制覆盖。
8. **token 一次性语义（小）**：apply 成功后才把 token 标记 used（temp+rename）；失败保留
   TTL 内可重试；baseline/workspaceKey 冲突 → 409 并作废 token。apply 幂等；崩溃后重试
   会因 baseline 变化而 409，安全。
9. **collect 围栏顺序（小）**：先 `canonicalize` 再与 canonical `artifacts/` 比对；
   拒绝 symlink。
10. **node_modules 截断优先级（小）**：SKILL.md/scripts/references 先于 node_modules；
    预算不足时先丢 node_modules，并标 `truncated=node_modules`。
11. **collections 位置（已定）**：`<dataDir>/collections/<projectId>/<collectId>/`；
    不在 bundle 根内；仍加入统一 deny/audit 清单，防未来改到项目 home。
12. **单活动工作区不变式（测试）**：禁止同一项目同时绑定两个不同 workdir/machine/container
    的会话；batch 任务必须使用项目当前工作区；加测试防未来入口破坏。

## 1. 事实基线（代码审计）

1. **控制面**：SDK 在 pi-web 的 Node 进程内加载 `<project-home>/.pi` 的 skills/agents/
   extensions/MCP/models；远端三种模式只把工具执行搬到工作区。
2. **当前上行**：`POST /api/projects/:id/workspace-config-sync` 先 dry-run 再 apply；
   apply 会**重新 collect**，`applyWorkspaceConfigSync` 是裸 `writeFile` 循环
   （`lib/workspace-config-sync.ts:298`），无原子、无备份、无锁。
3. **当前下行**：不存在通用投影。只有聊天附件在**上传时**做 Host→远端一次性镜像
   （`app/api/remotefs/[...path]/route.ts`，Host 先原子写、远端 temp+rename），
   以及 `share_file` 的 Host 回退。skill 脚本、agents 定义、其他会话上传的附件不会
   自动到达已有工作区。
4. **工作区 provider**：`WorkspaceOperations` 契约支持 `readFile(): Buffer` 与
   `writeFile(string | Uint8Array)`；但 relay/SSH 的 `writeFile` 对非字符串抛
   `UNSUPPORTED`（`lib/workspace-providers/relay.ts:91`、`ssh.ts:111`）。
5. **agent 能力**：0.6.0 已有 `workspace-base`/`binary-read`/`binary-write`；
   没有 `fs.manifest`，也没有 `projection-v1`。relay `ws` 服务端默认
   `maxPayload = 100MiB`；32MB 文件 base64 后约 43MB，仍在限制内。
6. **Apptainer**：`apptainer-cli-executor` 与 `ssh-executor` 都以
   `--contain --no-mount hostfs,cwd` 启动，只 bind 工作区种子和显式输入/输出目录；
   项目 home 不可见。原草案 §0 的风险在当前代码中已被缓解，但需要回归探针。
7. **项目模型**：一个 project 绑定一个活动工作区（`workdir`/`machineId`/`containerId`）；
   修改这些字段就是换工作区。没有“同一 project 并发多个不同 workdir”的记录。
8. **依赖**：`proper-lockfile` 已在依赖中且多处使用（provider credential、user
   settings、relay store）；`diff` 库没有，需要新增或自带一个行级 diff。
9. **路径护栏**：`SELF_PROTECTED_PATTERNS` 不含 `.sync-backups`；`DEFAULT_POLICY.denyWrite`
   不含 `.pi/attachments`。bundle deny 已排除 attachments（本轮已加）。
10. **批量任务**：`lib/batch/task-runner.ts` 自己构造 extension/remote 上下文，
   不走 `agent/new`/restore 的 share 上下文；投影若要覆盖 batch，需要单独接线。

## 2. 所有权模型（唯一真相 + 投影方向）

| 子树 | 主存 | 工作区副本 | 下行 | 上行 |
|---|---|---|---|---|
| `.pi/skills/**` | Host project home | 可写工作副本 | 漂移感知推送（clean 才覆盖） | 显式晋升（现有按钮，加固） |
| `.pi/agents/**` | Host project home | 可写工作副本 | 同上（可选，P1 可只做 skills） | 显式晋升 |
| `.pi/attachments/**` | Host project home | **只读缓存** | 自愈：缺失/漂移即用 Host 覆盖；Host 删除则删远端 | 无（不可变输入） |
| `.pi/extensions/**`、`mcp.json`、`models.json`、`prompts/**`、`themes/**`、`settings.json` | Host | 不投影 | 不推送 | 按现有闸门晋升；`models.json` **不参与 sync**（已定，模型只走 UI） |
| `.pi/sessions/**`、`.pi/tmp/**`、`.pi/plans/**`、`.pi/bin/**`、`.pi/cache/**`、`.pi/.sync-backups/**`、凭据 | Host / 运行态 | 不投影 | 不推送 | 拒绝 |
| `artifacts/**`（工作区根，新增约定） | 工作区 | 工作区本地 | 不投影 | **P2 选择性收取**（独立 API，非配置同步） |

说明：
- 安全边界不是“只读”，而是“上行必过闸，且不自动”。skills/agents 可写是为了
  让 Agent 原地编辑/自测；修改永远不能自动到达 Host。
- attachments 不可变：聊天附件统一唯一命名（见 §5），Host 只在“新文件”场景写入；
  远端副本是缓存，任何漂移都由投影覆盖。
- `artifacts/` 是工作区数据，不是配置；不进入投影集，也不进入配置同步的 `.pi` 扫描。

## 3. 下行投影 v1（不新增 agent 协议）

### 3.1 数据与 key

`<dataDir>/projection/<projectId>/<workspaceKey>.json`：

```jsonc
{
  "version": 1,
  "projectId": "…",
  "workspace": {
    "mode": "ssh",
    "root": "/root/MarLive",
    "backend": "101.200.163.35:22",
    "key": "ab12…"           // sha256(mode\nroot\nbackend)[:32]
  },
  "hostDigest": "…",         // sha256(sorted(rel:sha256))，投影集内容版本
  "updatedAt": "…",
  "files": {
    ".pi/skills/lint/SKILL.md": { "sha256": "…", "size": 1234, "mtimeNs": 0, "pushedAt": "…" }
  }
}
```

- `workspaceKey` 必须包含 mode + **canonical root** + 后端身份：relay=machineId、
  SSH=host:port、sandbox=platformUrl#containerId。canonical root 先做本地/远端可用的
  规范化（斜杠、去尾斜杠、realpath/realpath-equivalent；沙盒固定 `/workspace`）。
- manifest 里同时保存 `workspace.rootCanonical`。**key 变化但 canonical root 相同**
  （例如只改了 workdir 的写法）时继承旧 manifest，而不是从空开始；旧 key 记录迁移后
  删除。
- manifest 原子写（temp+rename）；损坏/缺失按空 manifest 处理（全量推送 + 日志）。
- **GC 与 reconcile 共用 per-key 锁**：reconcile 开始/结束都校验 root canonical 未变；
  key 有在途 reconcile 时 GC 跳过；GC 只清理超过保留期（默认 30 天）且无在途任务的 key。
- `deleteProject` 同时删除 `<dataDir>/projection/<projectId>`；`updateProject` 修改
  workdir/machine/container 时先取旧 key 锁、迁移/删除旧 key，再让新 key 从继承状态开始。
- 不做自增 epoch；`hostDigest` 是内容版本，也是“是否需要 reconcile”的快速判断。

### 3.2 投影集与读取

- 投影集 = `.pi/skills/**` + `.pi/agents/**` + `.pi/attachments/**`。
- Host 侧 walk：跳过 symlink、`isDeniedConfigPath`（凭据/运行态/.git 等）、
  `.sync-backups`；单文件 ≤32MB，总文件 ≤2000，总量 ≤64MB；超限记录 `truncated`
  并继续（不阻塞会话）。
- **根目录保护**：workspace root 为 `/`、盘符根或空字符串时拒绝投影（避免把 `.pi`
  写到文件系统根）；symlink 的 skill 目录跳过并在状态里提示（需要的话用实体目录/
  配置包分发）。
- 工作区侧：`ws.readdir` + `ws.stat`；skills/agents 逐文件 `readFile` + sha256
  （文本/小文件为主）；attachments 用 **mtimeNs+size** 作为快路径，命中 manifest
  记录值则假定 clean，变化才读/hash。
- **attachments 的弱判定必须兜底**：快路径可能漏掉“同尺寸且 mtime 被保留”的漂移
  （`utimes` 一行代码即可伪造）。因此增加：
  - 周期性全量内容 hash（默认每 10 分钟或每 N 次 reconcile 一次）；
  - `POST /projects/:id/projection/repair` 强制全量 hash + 覆盖；
  - 状态写 `lastVerifiedAt`；文档与 UI 不声称“绝对自愈”，只承诺“快路径 + 周期校验”。
  attachments 以图片为主、总量受 64MB 投影预算约束，周期全量校验可接受。
- `node_modules`：skills 下默认**包含**并计入 64MB 上限（已拍板）。预算不足时**按优先级
  截断**：`SKILL.md`、`scripts/`、`references/` 优先保留，`node_modules/` 最后；截断时
  状态标 `truncated: "node_modules"`，不静默按字典序丢掉脚本。

### 3.3 reconcile 规则

| 工作区 | Host | 动作 |
|---|---|---|
| 缺失 | 存在 | 推送（`ws.writeFile` 字节） |
| hash == manifest（clean） | hash 变化 | 推送覆盖 |
| hash == Host | — | 采纳（更新 manifest，不写） |
| hash != manifest 且 hash != Host（dirty） | 存在 | 保留 + dirty 标记 |
| clean | 从 Host 删除 | 删除远端 |
| dirty | 从 Host 删除 | 保留 + conflict 标记 |
| attachments 任意差异 | 存在 | 强制覆盖（Host 真相） |
| attachments | Host 删除 | 删除远端（tombstone 由 manifest 消失表达） |

- attachments 不做 dirty 判定：任何本地修改都是漂移，下回合被 Host 覆盖；
  这与其“只读缓存”语义一致。
- 推送/删除成功的文件才更新 manifest；失败保留旧 hash，下次重试。
- 结果写入 `<dataDir>/projection/<projectId>/<key>.status.json`：

```jsonc
{
  "updatedAt": "…", "hostDigest": "…", "durationMs": 42, "timedOut": false,
  "pushed": ["…"], "deleted": ["…"], "dirty": ["…"], "conflicts": ["…"],
  "errors": [{ "rel": "…", "error": "…" }],
  "truncated": { "reason": "max-bytes", "skipped": 12 } | null
}
```

### 3.4 触发、预算与成本控制

- **触发**：`rpc-manager` 的 `prompt` 路径，在 `inner.prompt` 之前；仅 remote 模式、
  非 quick、非 subagent；`steer`/`follow_up` 不触发；会话正在 streaming/prompt 时
  跳过（下一回合）。
- **上下文**：`RpcSessionStartOptions` 增加
  `projection?: { projectId: string; workspace: () => Promise<WorkspaceOperations> }`。
  `agent/new`、`session-restore-options`、`batch/task-runner` 用已有的
  `createProjectWorkspaceOperations(project, user, apiKey)` 构造**懒工厂**；
  解析失败（容器未起/agent 离线）只记录状态，不影响会话启动。
- **成本**：进程内按 project 维护 `{hostDigest, lastReconcileAt, dirtyFlag}`：
  - Host 侧上传成功（hostCache）、项目配置 apply、bundle apply 设置 `dirtyFlag`；
  - Host 侧维护 `(rel, size, mtimeNs, ino) -> sha256` 的 **stat 缓存**（复用
    session-list-scanner 的 fingerprint index 思路）：stat 命中直接复用 hash，
    miss 才读文件；`hostDigest = sha256(sorted(rel:hash))`。temp+rename、git checkout、
    备份恢复只会让 mtime 变一次、重算后 hash 不变，不会每回合假 dirty。
  - 该缓存与 session-list-scanner 有同样的盲区：**同尺寸且 mtime 被保留**的编辑
    （rsync -t、cp -p、tar 解包）可能被当成未变化。Host 是可信侧，且 upload/apply
    会置 dirtyFlag，`repair`/周期校验可强制全量重算；不要把它当安全边界。
  - 每次 prompt 先算 Host dig（stat 为主，只有未命中才读内容）；digest 未变且距上次
    reconcile < 60s 且无 dirtyFlag → 跳过；
  - 否则执行 reconcile；**单飞**（同一 workspaceKey 共享一个 Promise），开始时校验
    root canonical 未变；避免多会话重复与“工作区已换还在写旧根”。
- **预算**：单次 reconcile 5s（可配）；超时在文件之间中断，保留已完成 manifest，
  标 `timedOut`，本回合继续。远程调用逐个 `Promise.race` 超时，避免单文件挂死。
- **失败降级**：投影失败不阻塞 prompt；状态 API 可见错误；附件上传时已有的
  `hostOnly` 降级保持不变。

### 3.5 二进制写（v1 必须补）

`WorkspaceOperations.writeFile` 契约已支持 `Uint8Array`，但 relay/SSH provider 拒绝。
在 `lib/workspace-providers/relay.ts` / `ssh.ts` 补齐：
- relay：agent 支持 `binary-write`（0.6.0+）时用 `fs.write {contentBase64}`；
  旧 agent 对非 UTF-8 内容返回 `UNSUPPORTED`（文本仍可投影）。
- SSH：`sftpWrite` 接受 Buffer（SFTP 原生支持）。
- host/sandbox 已支持。
这样投影与配置同步共用同一个 provider 写入路径；附件/技能脚本的二进制不会损坏。

### 3.6 `fs.manifest` / `projection-v1`（P2 优化，可选）

v1 不依赖新协议。若 skills 树/大二进制导致每回合 hash 过慢，再加：
- Go `fs.manifest {path, maxFiles, maxBytes, hash:"sha256"}` → `{entries:[{path,size,mtime,sha256}], truncated}`；
- hello `features += "projection-v1"`；agent 0.7.0；五平台 dist；
- 旧 agent 继续走 v1 的 `readdir/stat/readFile` 回退。
这能把“每回合逐文件读”降为一次遍历；不是投影的前提。

## 4. 上行晋升加固（对 `ec2f2fec` 的修正）

### 4.1 Plan token：预览即所落盘

- `POST …/workspace-config-sync { dryRun: true }` →
  `{ token, workspaceKey, stats, files: [{rel, change, diff?, binary?, risk}], trust }`。
- token = 128-bit 随机；落盘 `<dataDir>/sync-plans/<token>/`：
  `meta.json`（userId/projectId/workspaceKey/homeBaseline/stats/createdAt/expiresAt/used）
  + `files/<rel>`（**只存变更写**，不存全量 collect）。
- **homeBaseline 覆盖全量 collected 的每个 rel**（存在→hash，不存在→null），
  **不只 writes**。理由：apply 的最终配置 = 缓存写 + home 未变化文件；未变化文件在
  预览后被 Host 编辑/另一次 apply 改掉时，只看 writes 的 baseline 拦不住，落盘的会是
  从未整体校验过的组合。预览时 `validateConfigWrites` 已校验全量 collect；未变化文件
  在预览时 home 内容与 workspace 字节相同，因此也在校验范围内；apply 全量比对 baseline，
  任何未变化文件漂移 → 409 重新预览。只需要存 hash（每个 rel 一行），
  不需要缓存未变化文件的内容。
- TTL 5 分钟；总量上限 128MB；创建时清理过期/已用。
- `POST { token }`：身份/项目/workspaceKey 匹配 → 取盘 → `proper-lockfile`
  （`<dataDir>/locks/<projectId>.lock`）→ 重读 home 全量比对 baseline →
  备份 → 原子写 → **成功后才**标记 used（meta 用 temp+rename）→ 返回
  `{stats, trust, applyId, reload}`。
- **一次性语义**：apply 失败（锁/IO/校验）保留 token 在 TTL 内可重试；baseline 或
  workspaceKey 冲突 → 409 并作废 token（重试也不会成功）；apply 幂等，崩溃后重试会因
  baseline 已变化得到 409，安全。`410` token 过期/不存在/已用；`409` workspaceKey 变化、
  home baseline 冲突、项目有运行中会话、锁竞争。apply 不再访问工作区（预览后工作区离线
  也能 apply）。

### 4.2 原子写、备份、回滚

- 抽出通用 `writeFileAtomic(path, bytes)`（复用附件的 temp+rename，Windows 用
  unlink+rename 兜底），附件与 sync 共用。
- 覆盖前备份旧文件到 `.pi/.sync-backups/<applyId>/<rel>`，写 `manifest.json`
  （applyId/ts/type/files[rel,existed,oldHash,newHash]）。
- `.sync-backups` 加入 `DENIED_SEGMENTS` 与 `SELF_PROTECTED_PATTERNS`；
  不导出、不投影、不回流；保留最近 10 个 applyId 或总量 256MB（取先到者）。
- 多文件一致性：**逐文件原子 + 项目空闲闸门**。apply 时若项目内有运行中的
  RPC 会话**或 batch 任务**，返回 409 `PROJECT_BUSY`（UI 提示等待/停止）；这样不会
  有 loader 在 rename 循环中读到混合版本。不要声称跨文件事务。
- **busy 判定必须看见 batch**：batch 的 `startRpcSession` 虽会进 registry，但当前
  wrapper 没有 projectId，按项目过滤会漏。给 `RpcSessionStartOptions`/wrapper 增加
  `projectId`，`agent/new`、restore、`batch/task-runner` 都传入；busy = 该 project 的
  活动 RPC wrapper（running/streaming/prompt pending）**∪** batch task registry 中
  running 的任务。restore 中的会话也计入（用 start lock 串行）。
- **共享锁**：新增 `lib/project-config-lock.ts`（`proper-lockfile` 锁
  `<dataDir>/locks/<projectId>/` **目录**，目录先 `mkdir -p`，避免锁不存在的路径），
  所有 project-home 配置写路径共用：sync apply/rollback、bundle apply、设置面板
  （models/auth/MCP/sandbox/platform）、项目 PATCH。baseline 只作为未接入写路径的
  兜底，不是主防线。
- **读侧也要进锁**：session start/restore 的 ResourceLoader 加载阶段拿同一把锁的
  **读锁**（进程内 RW lock；apply 持写锁）。否则“项目空闲”检查通过后、apply 写入期间
  刚好新建一个会话，仍可能读到混合版本。写路径的跨进程互斥用 proper-lockfile，
  进程内读写用 RW lock，两者组合。
- **rollback × 投影**：rollback 把 Host 技能回退旧版后，hostDigest 变化，但工作区里
  很可能还留着 Agent 的 dirty 编辑（正是晋升来源），按规则会被保留并标 conflict。
  这不是 bug，但必须在 rollback 返回 `projection: {needsDiscard, dirty}`，UI 明示
  “项目区已回退；工作区存在本地修改，需丢弃后才会同步回退版本”，并提供一键
  `POST …/projection/repair {all:true}`；可选 `discardWorkspaceChanges:true` 让用户
  在 rollback 时显式选择强制覆盖。
- 回滚：`POST …/workspace-config-sync/rollback { applyId, force? }`；
  先校验当前文件 hash 是否仍等于 apply 的 `newHash`，不一致返回 409（除非 force）；
  恢复/删除按 manifest，同样原子 + 锁 + 备份（type=rollback，可再回滚）。

### 4.3 预览升级：文件清单 + diff

- 服务端返回变更文件清单 + 文本 unified diff（单文件截断 64KB；二进制只给
  size/hash）；`mcp.json`、`.pi/extensions/**`、`.pi/settings.json`、`.pi/prompts/**`
  标 `risk: "high"`（可改工具默认/装载代码/prompt 内容）。`models.json` 不进入
  collect（§4.5），不会出现在此列表。
- 前端用 modal 替代 `window.confirm`；高风险项高亮并单独分组。
- 需要新增 `diff` 依赖或自带行级 diff；不要在前端拉全量旧/新内容。

### 4.4 生效与 reload

- apply 成功后对项目内**空闲**会话 fan-out `wrapper.reload()`（复用现有 RPC
  reload 逻辑）；运行中的会话设置 `reloadOnIdle`，在 `agent_settled` 后执行。
- **`reloadOnIdle` 归属**：只存 wrapper 内存，不持久化。会话被 idle eviction/heap guard
  驱逐或进程重启后，restore 从文件重建时天然加载新配置，标记丢失无影响；不要写进
  session 元数据。fan-out reload 走 per-session start lock，跳过正在 restore/streaming
  的会话；reload 失败清理标记并在 projection/status 里记录，下一次 apply 或用户手动
  `/reload` 再试。
- 返回 `reload: {requested, pending}`；UI 提示“已应用；空闲会话已重载，
  运行中会话将在回合结束生效”。
- 没有这个 fan-out，“编辑→晋升→测试”回路仍要用户手动 `/reload`。

### 4.5 models.json（已定：完全不参与 sync）

**已拍板：`models.json` 完全不需要、也不参与配置同步。** 模型配置由 UI 管理即可，
不做“管理员勾选同步”的变体。实现上用 **sync 专属 deny**（`workspace-config-sync.ts`
的 `SYNC_DENIED_BASENAMES`）跳过 `models.json`；不要把它加进全局 bundle deny
（配置包导出/导入仍需要 models.json）。collect 阶段直接跳过，diff modal 不展示。
理由：模型配置是部署级、可含凭据，工作区一份格式错误的 models.json 回流会清空
项目模型列表；与 Agent Builder 的“模型配置不入包”一致。
`mcp.json` 保持现有校验 + 模式预检；extensions 保持 trust 门。

### 4.6 删除语义

上行为增量晋升：只增/改，不传播删除。Host 侧提供技能/文件删除入口；
Host 删除经下行投影传播到 clean 副本。UI 明示“同步不会删除项目区已有文件”。

## 5. 附件生命周期（与投影对齐）

1. **唯一命名**：聊天附件（图片和非图片）统一存为
   `<时间戳>-<随机>-<原名>`；mention 使用存储名。这样“重新附加同名文件”不会
   覆盖旧附件，也不需要 `skip` 语义；Host 原子替换只用于异常重试。
2. **上传快路径**：保持 `hostCache=1`：Host 先原子写，再远端 temp+rename 镜像；
   镜像失败 → `hostOnly` + 警告，不插悬空 `@`。
3. **投影补推**：投影集包含 `.pi/attachments/**`；上传时未连上的工作区、
   旧 agent 的 hostOnly、其他会话/工作区的新附件，在下一次 reconcile 补推。
4. **只读**：path guard 增加 `denyWrite: [".pi/attachments/**"]`（读允许；
   server 写入不受 agent guard 影响）；模型要改附件应复制到 `artifacts/`。
5. **删除传播**：项目菜单清理 Host attachments 后，投影在下一回合删除远端
   对应文件（manifest 中有、Host 已无 → 删除）；Host 目录清理同理。
6. **限额**：聊天附件单文件 32MB（与 `/api/files` 统一，或统一到 25MB）、
   每消息合计 64MB；`hostCache=1` 的 remotefs POST 服务端 413，客户端预检提示。
   大文件（200–500MB）按用户决策直接放工作区（文件浏览器/SCP），不走聊天附件。
   relay `ws` 默认 100MiB frame，32MB base64 ≈ 43MB，安全。

## 6. 选择性收取（P2，原草案遗漏）

- 工作区约定：Agent 产物写 `artifacts/**`（工作区根，普通目录；不进投影集，
  不进配置同步的 `.pi` 扫描）。系统提示词/skill 约定说明。
- `POST /api/projects/:id/collect { paths: string[] }`：用户认证 API，
  **永不注册为 agent 工具**；路径必须相对、位于 `artifacts/`（v1 白名单），
  拒绝 symlink/`..`；单文件 ≤32MB、总量 ≤128MB、文件数 ≤200。
- **围栏顺序**：先 `ws.canonicalize(path)`，再与 canonical 的 `artifacts/` 根做包含
  判断（先解析后比对，不能先比对后解析）；symlink 目标在根外一律拒绝。
- Host 落点（已定）：`<dataDir>/collections/<projectId>/<collectId>/<...>`，
  写 `manifest.json`（来源 workspace/路径/大小/hash）。不放进项目 home，避免混入 `.pi`
  与配置包导出范围；仍加入统一 deny/audit 清单，防止未来改到项目 home 时漏掉。
- UI：文件浏览器多选 →「收取到项目区」；项目菜单「已收取文件…」列表/下载/删除。
  由于 Host 文件浏览器看不到项目区，这个管理入口是必需的。
- 冲突：目标同名 → 覆盖/保留两份/改名，由用户在收取时裁决。
- 安全：纯数据落盘；不写入 extensions/skills/mcp.json 等可加载路径；
  收取内容不触发 trust/加载。

## 7. 安全不变式

1. 晋升、回滚、收取都是用户认证的 API，**不是 agent 工具**。
2. 凭据、运行态、`.sync-backups`、`collected` 永不导出/投影/回流；deny 清单扩充并测试。
3. 落盘字节 = 预览字节（token）；校验失败零写入。
4. 工作区 symlink/`..` 围栏；Host walk 跳过 symlink；remote key 围栏。
5. attachments 只读（agent 写拒绝）；投影提供“stat 快路径 + 周期全量校验 + repair 强制”
   的有界自愈，不声称绝对自愈；artifacts 可写但不自动上行。
6. 项目带运行中 RPC 会话**或 batch 任务**时拒绝配置 apply；所有 project-home 配置写路径
   共用同一把锁，避免 loader 读混合版本。
7. 投影/备份/收取/plan 状态都在 `.pi` 之外或 denied 段，互不交叉；GC 与 reconcile
   共用 per-key 锁，key 迁移不丢 manifest。
8. 同一项目同一时刻只有一个活动工作区（v1 假设）：workdir/machine/container 不允许被
   两个活动会话并发绑定；batch 使用项目当前工作区。

## 8. API 契约（摘要）

```
POST /api/projects/:id/workspace-config-sync
  { dryRun: true } → { token, workspaceKey, stats, files:[…], trust }
  { token }        → { stats, trust, applyId, reload }
  409/410 语义见 §4.1；models.json 不进入 files

POST /api/projects/:id/workspace-config-sync/rollback
  { applyId, force?, discardWorkspaceChanges? }
  → { stats, applyId, reload, projection:{needsDiscard, dirty:[…]} }

GET  /api/projects/:id/projection
  → { workspaceKey, hostDigest, last:{…}, dirty:[…], conflicts:[…], errors:[…],
      lastVerifiedAt }
POST /api/projects/:id/projection/repair
  { paths?: string[], all?: boolean, verifyAll?: boolean }
  → { repaired:[…], verified:[…], errors:[…] }

POST /api/projects/:id/collect
  { paths: string[] } → { collectId, files:[{rel,size,hash}] }
GET  /api/projects/:id/collected → { items:[…] }
DELETE /api/projects/:id/collected/:collectId
```

## 9. 实施清单

**P0（先做，风险最高/改动小）**
1. `lib/workspace-config-sync.ts` + sync route：token/盘缓存/baseline/lock；
   `writeFileAtomic` + 备份 + rollback；项目空闲闸门；apply 后 reload fan-out。
   - **baseline 覆盖全量 collected 的每个 rel**（hash/null），不只 writes；
   - **token 生命周期**：成功后才 used；失败可重试；409 作废；
   - **busy 并入 batch**：`RpcSessionStartOptions`/wrapper 加 projectId；
     batch task registry running 任务计入；
   - **共享锁** `lib/project-config-lock.ts`：sync/bundle apply/settings/models/MCP/
     sandbox/项目 PATCH 全部接入；
   - `deleteProject` 清理 `<dataDir>/projection/<projectId>`、`sync-plans` 中该项目的
     未消费 token、`collections/<projectId>`（P2 落地后）；`updateProject` 换工作区时
     按 §3.1 迁移旧 key。
2. `.sync-backups` 进入 `DENIED_SEGMENTS` + `SELF_PROTECTED_PATTERNS`；
   `.pi/attachments` 加 `denyWrite`；`<dataDir>/collections` 加入统一 deny/audit；
   测试路径护栏。
3. attachments：聊天附件统一唯一命名；32MB 限额（client + `hostCache` 服务端）；
   Host 清理 → 投影删除传播（P1 reconcile 用“manifest 有、Host 当前集无”即可判定，
   不需要额外 tombstone；P0 的清理菜单只删 Host，远端副本留到下一回合）。
4. diff modal（新增 `diff` 依赖或行级实现）；**`models.json` 完全不进入 sync**
   （collect 跳过、diff 不展示）；高风险项高亮。
5. Apptainer 回归探针：沙盒内断言项目 home 不可见/不可写（VM/平台各一次）。

**P1（下行投影 + 闭环）**
1. `lib/projection/policy.ts`（子树/deny/limits/symlink）、`manifest.ts`（canonical key/
   原子/迁移/GC）、`reconcile.ts`（规则/单飞/预算/状态）、`status.ts`。
   - **per-key 锁**：reconcile 与 GC 共用；GC 跳过在途；root canonical 变化即放弃；
   - **key 迁移**：key 变但 canonical root 相同 → 继承 manifest；
   - **hostDigest stat 缓存**：`(rel,size,mtimeNs,ino)->sha256`，命中不读内容；
   - **attachments 周期全量校验**：默认 10 分钟/每 N 次，repair 强制；状态
     `lastVerifiedAt`；
   - **node_modules 优先级截断**：脚本/参考文档先于依赖。
2. relay/SSH provider 字节写（contentBase64 / SFTP Buffer）；复用 `writeFileAtomic`。
3. `RpcSessionStartOptions.projection` + `agent/new`/restore/batch 懒工厂；
   `rpc-manager` prompt 钩子 + dirtyFlag/TTL/hostDigest；batch 任务启动时 reconcile。
4. `GET /projects/:id/projection` + `repair`；项目菜单「工作区同步状态…」
   （dirty/conflict 列表 + 丢弃恢复）。
5. rollback × 投影：返回 `needsDiscard`，UI 提供一键丢弃；reload 标记只存内存，
   restore 兜底，fan-out 走 start lock。
6. 测试矩阵（见 §10）；VM SSH/sandbox/local-machine 真机。

**P2（可选/优化）**
1. `fs.manifest` + `projection-v1`（agent 0.7.0，五平台 dist，旧 agent 回退）。
2. 选择性收取 API/UI；Host 收集库管理。
3. 投影状态徽标（项目行/文件树）；nodes_modules 策略调优；大文件分块。
4. Apptainer bind/host-local 快路径——需要平台 executor 支持额外 bind（SSH executor
   目前明确拒绝 mountDirs），不是 pi-web 单侧能完成；仅同机 local executor 可行。

**P3（不建议近期做）**
- 并发多工作区（需要 project workspace 记录/选择器/租约）；对象存储数据面；
  FUSE/网络挂载（违反 relay 出站-only/零依赖）。

## 10. 测试矩阵

- 投影规则：缺失/clean+dirty、Host 新增/修改/删除、clean 删除、dirty 保留、
  dirty×删除冲突、attachments 周期自愈、Host 删除传播、adopt-equal、manifest 损坏、
  **key 迁移（canonical root 相同）**、**GC 与在途 reconcile 并发**、truncated/超时、
  单飞并发、旧 agent 文本回退/二进制 UNSUPPORTED。
- 二进制：relay 0.6.0 contentBase64、SSH Buffer、sandbox bytes、host bytes；
  图片/PDF 经投影后 sha256 不变。
- 同步：token 预览后改工作区不影响落盘、**改任意未变化 home 文件 → 409（baseline
  全量）**、token 过期/重放/**崩溃后重试**、workspaceKey 变化、并发 apply、锁竞争、
  备份/rollback 往返、rollback 目标被改、**rollback 后工作区 dirty → needsDiscard**、
  项目运行中/batch 运行中 409、apply 后 reload。
- 安全：`.sync-backups` 导出/导入/投影/读取均拒绝；attachments agent 写拒绝、
  读允许；`/etc` 等越界 Host 目录清理 403；**collect canonicalize 后围栏**。
- 不变式：**同一项目不能同时绑定两个不同 workdir/machine/container 的活动会话**；
  batch 任务使用项目当前工作区；batch 会话被 busy 判定看见。
- UI：diff modal 高风险高亮；dirty 列表/丢弃；assets 收取列表。
- 性能：1000 文件 reconcile < 5s；Host digest stat 缓存命中时 prompt 额外开销 < 50ms
  （temp+rename 后只重算一次）；32MB 附件经 relay 上传成功且无 `.upload-*` 残留；
  attachments 周期全量校验不阻塞 prompt。

## 11. 已拍板（原开放问题）

1. `models.json`：**完全不参与 sync**；模型配置只走 UI。
2. 收取落点：**`<dataDir>/collections/<projectId>/<collectId>/`**；不进项目 home，
   加入统一 deny/audit 清单。
3. skills 下 `node_modules`：**计入 64MB 投影预算**；预算不足按优先级截断
   （脚本/参考文档优先，node_modules 最后）。
4. 并发多工作区：**近期不做**；v1 坚持“一个项目一个活动工作区”，并加不变式测试
   防止未来入口破坏。真正并发需要 project workspace 记录/选择器/租约（P3 前置）。
