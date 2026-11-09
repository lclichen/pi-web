# pi-web 多用户性能优化（2026-11）

目标：**50 用户 × 2 并发会话（100 活跃会话）**下，任何用户触发的工具/操作不得阻塞整个服务，后端服务不能崩溃。正式部署服务器 ≈40G 内存 + 服务器级 CPU；测试环境为开发机（dev）与 10.99.9.7 VM。

本页是本次工作流的主文档：根因分析 → 上游对齐决策 → 批次改动清单 → 压测结论。

---

## 1. 架构事实（一切分析的前提）

- **所有 agent 会话都是同进程 SDK AgentSession**：`startRpcSession()`（lib/rpc-manager.ts）在 Next.js 服务进程内用 `createAgentSessionFromServices` 建会话，注册在 `globalThis.__piSessions`。没有每会话子进程，全仓零 `worker_threads`。
- 因此：100 会话的模型流解析、SSE 扇出、JSON.parse、同步 fs 全部在**同一个 Node 事件循环**上。HTTP 服务与 agent 同进程——事件循环停滞 = 前端"不可访问"。
- 部署形态 `next start -p 30141` 单进程；无进程监督/自动重启。

## 2. "应用卡住、前端无法访问、无日志"根因分析

按嫌疑度排序（行号为 dev-0.85.1 实测证据）：

### 2.1 会话列表重扫风暴（最高嫌疑）

机制链条：

1. 任一会话回合结束 → `agent_end` → `invalidateSessionListCache()` **无 space 参数 = 失效所有用户空间缓存**（rpc-manager.ts:519-521 → session-reader.ts:430-442）。同类调用共 ~12 处。
2. 所有前端每 2.5s 轮询 `/api/agent/running`（SessionSidebar.tsx:220），发现 `sessionListVersion` 变化 → 节流 10s 内全量拉 `/api/sessions`。
3. 缓存刚被失效 → 冷重建 = SDK `SessionManager.listAll()` **逐行 JSON.parse 所有会话文件** + 每 subagent 会话同步有界读 + 每 cwd 起 `git rev-parse` 子进程 + 每会话 statSync。
4. 100 会话高频结束 ⇒ 缓存常年冷 ⇒ 事件循环被同步扫描持续占据 + 磁盘/CPU 洪峰。

这是"14k 请求/1.3GB"事件的完整机制；前端侧节流已修（10s 节流、memo 化 authInfo、子代理面板自适应轮询），**服务端侧的失效粒度与扫描成本从未修过**。

### 2.2 请求路径同步全量 parse

SDK `loadEntriesFromFile`（session-manager.js:277）：openSync+readSync 循环+逐行 JSON.parse，完全同步。命中路径：

- SSE 冷启恢复：`/api/agent/[id]/events` → `startRpcSession` → `SessionManager.open`（rpc-manager.ts:2829）；
- 会话详情页：`/api/sessions/[id]`（route.ts:47）；
- **历史分页每翻一页**：`/api/sessions/[id]/context`（route.ts:41）重新 parse 整个文件；
- fork/clone/set_tools 等另 ~6 处。

20MB 会话 ≈ 75-150ms 事件循环停滞；0.4-1s@100MB。50 用户同时打开页面 = 秒级连续停滞，SSE 心跳（30s）被饿死 → 代理/EventSource 超时 → 重连风暴 → 更差。

### 2.3 内存无界 → OOM kill

- SDK `fileEntries` 全量驻留堆（≈磁盘体积 × 3 的 JS 对象开销）；活动 wrapper 另持 activeToolEvents/widgets。
- 空闲回收（默认 10 分钟，rpc-manager.ts:187）被 **SSE 页面租约**（session-liveness.ts，90s/30s 续期）阻止：页面开着就永不回收。50 用户 × 开着页面 = 100 份全转录永久驻留。
- 无 LRU、无上限、无逐出 ⇒ 多 GB 堆 ⇒ OOM kill。OOM 是 SIGKILL，进程直接消失——与"前端无法访问、无日志"完全吻合：全仓只有 console.\* 到 stdout（无文件日志），部署脚本 nohup 重定向的日志在进程被 kill 时也已丢失最后缓冲。

### 2.4 进程级异常零兜底

全仓无 `uncaughtException`/`unhandledRejection` 处理器。Node ≥15 对 unhandledRejection 默认 throw → 游离 Promise rejection（如 SSE/扩展/relay 路径）直接崩掉整个服务进程。

### 2.5 SSE 零背压

`agent-event-stream.ts`/`sse-stream.ts`/`task-event-stream.ts` 的 `controller.enqueue` 无 desiredSize 检查、无队列上限（ReadableStream 默认无限排队）。慢客户端（手机、后台标签页、弱网）让每连接内部队列无界增长——内存放大器，与 2.3 叠加。

### 2.6 次要放大器

- `session-metas.ts`：每次 `getSessionMeta()` statSync（列表路径每会话一次）；每次 `recordSessionMeta` 全量 writeFileSync 整个 store（建会话/每回合 prompt-pin 漂移时）。
- `getRpcSessionInfos()`：每次 `/api/sessions` 请求 O(全部活跃会话 × 全部条目) 遍历 + 每会话 existsSync（rpc-manager.ts:2690-2745）。
- 每连接每事件独立 `toClientAgentEvent` 投影 + `JSON.stringify`（N 连接 = N 次）。
- 交互会话创建**无任何准入上限**（`/api/agent/new` 无配额；默认 4 并发限制只覆盖批量 API）。
- 8 终端全局共享上限（local-terminal.ts:51）在 50 用户下是争抢 bug（本次不动，记录）。

## 3. 上游对齐决策（agegr/pi-web main，fork 点 v0.8.11 后上游 596 提交，核查至 tip 6d9b743）

上游已在单租户前提下做了四项性能工作，**采纳其设计**避免未来同步冲突：

| 上游提交 | 内容 | 我们的决策 |
|---|---|---|
| `8cbafdd`+`234e19e`+`8e602ca`+`1a94341` | 增量扫描器：指纹缓存 + 持久化索引（5s 去抖）+ ResumePoint 尾部续扫（150MB 文件追加行 260ms→<1ms）+ 目录成员检查节流；接线在 session-reader 层 | **移植进 dev scanner**，并加目录参数支持用户 shard（上游单租户只扫 host 根）；接线点一致 |
| `6b0c6a5`+`b8e0b71` | SSE 背压：512KB 高水位 + desiredSize 计量 + 可丢弃事件（增量/partial 工具输出）+ 16MB backlog 上限（env 可调）超限 error-close 重连重建快照 + tool_execution_update 150ms 合并 | **整体移植**进 dev agent-event-stream；同模式应用于 dev 独有 sse-stream / batch task-event-stream |
| `6425d0d` | SDK 预热导入（修 Windows 首访秒级冷启） | 采纳（instrumentation 启动时 import） |
| （session-reader.ts:476-594） | SessionManager 只读 LRU 缓存 `openSessionManager`（12 条 / 256MB 总量 / 单条 64MB 上限，指纹失效，mutable 绕过） | **采纳**进 dev（放 lib/session-open.ts），并叠加自研 worker 解析（上游无 worker：其单租户下首个大文件同步 parse 可接受；我们 50 用户并发恢复不可接受） |

上游**没做**、由我们补：worker 线程大文件解析、per-space 失效/版本、准入上限、内存守卫、进程异常兜底、文件日志、压测体系。

**有意分歧**（上游已删除、dev 保留）：`session-metas.ts`（多用户 mode/owner 必需）、`sse-stream.ts`（控制面流复用）、per-space 签名 `listAllSessions(space,{force})`/`invalidateSessionListCache(space?)`（dev 路由已有 MERGE-NOTE 记录）。未来同步以 dev 为准。

## 4. 批次改动清单

| 批次 | 内容 | 状态 |
|---|---|---|
| B1 | SSE 背压（上游移植）+ 事件单次序列化 + unhandled/uncaught 兜底 + SDK 预热 + 文件日志 server-log + debug 进程指标（内存/事件循环延迟） | ✅ |
| B2 | scanner 上游移植 + 多用户 shard 化 + 接线 listAllSessions + 失效作用域化 + per-space 版本 + getRpcSessionInfos memo + metas 优化 | ✅ |
| B3 | openSessionManager LRU（上游移植）+ ≥2MB 文件 worker_threads 解析注入 preloadedFileEntries + 调用点迁移 | ✅ |
| B4 | /api/agent/new 准入（per-user 默认 8 / 全局默认 400，env 可调）+ 内存守卫（auto = 70% heap_size_limit） | ✅ |
| B5 | perf/ 压测体系：mock-model-server（全局预算公平分享 300 tok/s / 单流上限 80）+ setup-mock-provider + load-run 驱动 + README | ✅ |
| B6 | 单测 + 全量测试 + 本机冒烟 + VM 50×2 正式压测 | ✅ |

各批次独立 commit，可单独回滚。

## 5. 容量规划（40G 服务器）

- **内存守卫自适应**：默认阈值 = `70% × v8.getHeapStatistics().heap_size_limit`。生产用 `NODE_OPTIONS=--max-old-space-size=...` 提高 heap 上限时守卫自动跟随；`PI_WEB_SESSION_HEAP_GUARD_MB=0` 关闭。
- **会话上限**：全局默认 400（50 用户 × 2 = 100 目标负载的 4 倍余量），`PI_WEB_MAX_LIVE_SESSIONS` 可调；per-user 默认 8，`PI_WEB_MAX_SESSIONS_PER_USER`。
- **SSE backlog**：默认 16MB/连接，`PI_WEB_SSE_BACKLOG_LIMIT_BYTES` 可调；50 用户 × 多标签的最坏情形由准入上限兜底。
- **worker 解析池**：默认 2 线程（`PI_WEB_PARSE_WORKERS`），大文件恢复排队不占事件循环。
- 40G 生产建议基线（据 VM 实测外推，见 §6）：`--max-old-space-size=24576`、`PI_WEB_MAX_LIVE_SESSIONS=600`，其余默认。

## 6. 压测结论

（VM 50×2 正式压测后回填：金丝雀延迟分位、事件循环延迟 p95、RSS 曲线、单会话内存实测、mock 吞吐对齐、崩溃次数。）
