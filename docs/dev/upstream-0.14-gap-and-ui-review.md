# 上游 pi-web 0.14.x 对照：框架遗漏项与 UI 可引入项

> 日期：2026-11-03
> 对照对象：`upstream/main` @ `1fbf6c66`（Release v0.14.2，2026-11-03）
> 我方：`dev-0.85.1` @ `a837f699`（pi-web 0.9.0 / pi SDK 0.85.1）；
> 参考主线：`dev` @ `4242043d`（pi SDK 1.1.0）
> 提交范围：`c3c5c6fb..upstream/main`，共 **292 个提交**（merge-base 为 2026-10-08）。
>
> 本文是 [agent-framework-review.md](./agent-framework-review.md) §9「与完善 Agent 框架的差距」
> 的上游对照补充。目标不是“上游有什么就抄什么”，而是逐项确认：
> **上游是否已经有解、解法是否适配我们的多用户/五模式架构、值不值得引入。**

---

## 0. 先看结论

### 0.1 一句话结论

上游 0.14.x 不是“更完整的 Agent 框架”，而是**刻意收窄的 pi Web 前端**。
`CONTRIBUTING.md` 的 “Out of scope” 明确拒绝了调度器、长期后台 agent、
新子系统、IDE/Git 客户端、自定义主题、更多会话管理等——恰好覆盖了我们
遗漏清单里最重的那几项。**因此 18 项遗漏中，上游完整解决的几乎为零，
只有运行时与可观测性有可复用的构件。**

这与当前决策一致：

- 记忆系统：上游没有 → 继续搁置，按环境/用户/项目自研；
- RAG / 知识库：上游没有 → 按计划作为 MCP 引入，不进 Agent 框架；
- 跨项目子代理：上游也没有（只有同 repo worktree 隔离）→ 暂不做；
- 工作流 / 定时任务：上游明确建议做成 pi 扩展（issue #666）→ 优先级低，
  固定流程交给插件/扩展，不引入调度子系统。

### 0.2 真正值得动手的 3 件事

| 优先级 | 事项 | 性质 | 状态（2026-11-03） |
| --- | --- | --- | --- |
| **P0** | preview-mode secret 绕过修复 | 安全，与 pi 版本无关 | ✅ 已落地：`bin/rotate-preview-secrets.js` + 所有启动路径；VM 已轮换验证 |
| **P1** | 补全 lease 续约（0851 缺失） | 正确性，小改动 | ✅ 已落地：`/api/agent/[id]/lease` + 客户端 30s 续约（无 stream 时创建 page lease） |
| **P1** | bg-shell 注册 session liveness | 正确性，小改动 | ⬜ 待做：任务运行期间注册 provider，会话不被回收 |

### 0.3 值得引入的构件（按性价比）

1. **Debug panel**（`ed041eed` 等）：只读连接/会话/流/子代理/MCP/终端快照，是上游唯一的成体系观测面；我们 50 用户规模很需要。
2. **hidden page stream release**（`70b2947c`）：浏览器 HTTP/1.1 每源 6 连接，隐藏标签页释放空闲 SSE；我们的 agent/terminal/file-watch 三条流同样会撞上限。
3. **session list tail rescan**（`1a94341c`）：只扫增长文件的新增尾部；我们目前按 size/mtime 命中缓存，但文件一增长就整文件重扫，20MB 会话约 75–150ms。
4. **compaction prompt queue**（`a2950256`）：手工压缩期间把 prompt 停泊并在 `compaction_end` 按序放行；我们现在会直接被 SDK 拒绝。
5. **codemode / MCP host**：设计很好，但依赖 pi 1.x（`registerMcpServer`、内置扩展），0851 的 pi 0.85.1 不可直接用；等 pi 升级再评估。

### 0.4 UI 方面

上游 UI 改动很多，但**侧栏与设置两套大改与我们 0851 的自研 UI 冲突**，
不建议整包引入。低耦合、可直接拿的有：

- favicon 未读/待输入角标；
- Git 变更面板 Tree/List 切换；
- CSV/TSV 表格预览、SVG 代码块预览、公式复制；
- 正文文件默认换行；
- 附件按钮支持任意文件（不只图片）；
- 模型图片尺寸上限、自适应思考、按模型 Base URL；
- PWA 运行时应用名；
- 终端主题/字号跟随、手机上 Termux 风格扩展键；
- 会话“在新标签页打开”、项目重命名/排序、批量归档/删除全部会话；
- 消息级：轮次耗时、用量明细/平均速度、压缩摘要默认折叠、工具平铺参数。

完整清单见 §5。

---

## 1. 对照口径

### 1.1 版本与差异规模

| 项目 | 我方 `dev-0.85.1` | 我方 `dev` | 上游 `main` |
| --- | --- | --- | --- |
| pi-web 版本 | 0.9.0 | 0.9.0 | 0.14.2 |
| pi SDK | 0.85.1 | 1.1.0 | 1.5.0 |
| Next.js | ^16.3.5 | ^16.3.5 | 16.4.4 |
| 与上游 merge-base | `c3c5c6fb` | `c3c5c6fb` | — |
| 上游领先提交 | 292 | 292 | — |
| 多用户/平台认证 | 自研（platform 代理 + 角色） | 同左 | 无（只有 `PI_WEB_PASSWORD`） |
| 执行模式 | host/sandbox/local-machine/ssh/quick | 同左 | host + worktree |
| 子智能体 | tintinweb 包 | tintinweb 包 | 自研内置 subagent runtime |
| MCP | adapter | adapter | pi 1.x 内置 MCP host |

> 结论前提：**上游不是我们的“未来版本”**。上游没有多用户、五模式、
> relay、配置包、平台登录；它的很多实现不能直接套到我们的产品形态上。

### 1.2 上游自己划的边界（原文要点）

`CONTRIBUTING.md`（`7cc18031`，2026-10-14）明确列为 out of scope：

- 改变 pi 本身行为（system prompt、工具、重试、压缩、会话文件格式）；
- 可以做成 pi 扩展的功能，例如**定时消息**（并点名 issue #666）；
- 只有 Pi Web 认的配置/扩展 API；
- IDE 或 Git 客户端功能（编辑文件、文件管理、提交历史、第二套 diff）；
- **新的子系统或运行模式**：定时调度、长期运行的后台 agent、插件/UI 插槽、精简模式、多窗格；
- 内置主题之外的视觉定制；
- 更多的会话管理（只保留列表、置顶、归档、重命名、Fork、删除、项目排序）；
- 修改 pi 私有方法/内部状态。

这条边界解释了一个看似矛盾的现象：**上游 292 个提交里没有我们最想要的
“记忆 / 编排 / 治理 / 运维”能力，不是他们没想到，而是他们明确不做。**

---

## 2. 遗漏项逐项对照

> 对应 [agent-framework-review.md](./agent-framework-review.md) §9.1–§9.11。
> “上游有解”一列：✅ 完整方案；🟡 有可复用构件/局部缓解；❌ 没有；
> 🚫 明确 out of scope。

### 2.1 运行时（§9.1 / §9.1b）

| 遗漏项 | 上游有解 | 证据与边界 | 对 0851 的建议 |
| --- | --- | --- | --- |
| **单进程** | ❌ | `AGENTS.md`：`POST /api/agent/[id]` → `startRpcSession()` **creates the AgentSession in-process**。0.14.2 仍是单 Node 进程；Docker 镜像也只是换个壳 | 自研 worker/进程池，不能等上游 |
| **无 worker/背压** | 🟡 | 只有 codemode 的 QuickJS worker 池：`PI_CODEMODE_MAX_WORKERS` 默认 8（`6b8005df`，`lib/codemode-workers.ts`），每 worker 256MB；**不是会话级 worker**。另有 liveness/隐藏页释放流、压缩队列、尾部扫描等减压措施 | 借“限额+排队”思路；会话并发仍要自研 |
| **长任务无 checkpoint** | ❌ | 会话按 entry 持久化；Fork/side chat 可复制分支；**没有 mid-run checkpoint，也没有工具状态恢复**。Stop 卡死时靠 `forceShutdownOnIdle` 兜底（`b593cd6b` 之前已有） | 自研；先做 per-turn checkpoint 语义 |
| **bg 不自动唤醒** | 🟡 | 上游没有 bg 任务；但提供 **extension liveness provider**（README §Extension Session Liveness，`lib/session-liveness.ts`）：扩展有 detached work 时阻止 idle 回收。**没有定时器/唤醒机制** | 我们 bg-shell 的终态 `<task-notification>` + `followUp` 已经是唤醒逻辑；缺的是“活着等到唤醒”（见 §3.3） |

**关于 9.1b 的补充**：上游把“页面保活”从 90 秒 lease 记录改成**每会话一个 idle 倒计时 +
页面每 30 秒续约**（`b593cd6b`），并让隐藏页在 30 秒后释放空闲 SSE（`70b2947c`）。
这不是容量方案，但能避免“标签页开着、会话却被回收”和“隐藏标签页占满 6 条连接”。
我们的 0851 连 lease 续约都还没接上（§3.2）。

### 2.2 记忆（§9.5）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **长期记忆 / 跨会话记忆** | ❌ | 全仓无 long-term memory / memory store / 向量检索；`CONTRIBUTING.md` 把“新子系统”列为 out of scope | 继续搁置；按环境/用户/项目自研 |
| **RAG / 知识库** | ❌ | 无 embedding / vector / knowledge base | 按计划作为 MCP 引入，不进本框架 |
| 可复用的上下文机制 | 🟡 | Fork、side chat（保留父会话历史）、skills、AGENTS.md | 只能算“上下文复用”，不是记忆 |

### 2.3 编排（§9.6）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **ACP** | ❌ | 全仓 `AgentClientProtocol` / `acp` 零命中 | 不做/自研 |
| **多根工作区** | ❌ | 只有 git worktree（同 repo 多 checkout）；`multi-root` 仅出现在 branch tree 测试 | 暂缓 |
| **跨项目子代理** | ❌ | 子代理支持 `isolation: "worktree"`（同 repo，`d92eb836`），没有跨 cwd/跨项目 | 按决定不做 |
| **工作流 / DAG** | 🚫 | 无 workflow 引擎；固定流程建议交给扩展/插件 | 与当前判断一致 |
| **定时任务 / 调度器** | 🚫 | `CONTRIBUTING.md` 明确 out of scope；定时消息建议做成 pi 扩展（#666） | 不引入 |
| 可复用的编排构件 | 🟡 | ① **side chat**（`3bad742d`，ADR 0007）：从当前会话 fork 一个隐藏侧会话，保留父上下文、工具收窄；② subagent wait budget（`246e6256`）；③ codemode：模型写 JS 在 QuickJS 里编排工具调用（依赖 pi 1.x） | side chat 可评估（§4.7）；codemode 等 pi 升级 |

### 2.4 治理（§9.7）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **工具级审计** | ❌ | 全仓无 audit log / 审计事件；上游单用户模型，没有“谁做了什么”的需求 | 自研（我们多用户已有归属/栅栏/接管基础） |
| **管理员访问审计** | ❌ | 上游无 admin 角色；我们的只读支持视图 + 1h 接管已领先，但**接管留痕**仍待补 | 自研；在现有 takeover 上记录事件 |
| **数据保留策略** | ❌ | 只有 archive / 批量删除 / idle 超时；没有 TTL、保留期、导出后清理 | 自研 |
| 可复用的安全构件 | 🟡 | project trust 每次 prompt 重读（ADR 0006）；命令环境清洗（ADR 0001）；preview secret 轮换（`cf3ebfba`，见 §3.1） | 引入 `cf3ebfba`；其余已具备或参考 |

### 2.5 可观测 / 评测（§9.8）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **OTel / trace / metrics** | ❌ | 无 OpenTelemetry / Prometheus；`@earendil-works/pi-telemetry` 只在 `package.json` 钉版本，源码零引用 | 自研；先做 Debug panel |
| **工具级指标 / 告警** | ❌ | Debug panel 是状态快照，不是指标；无告警 | 自研 |
| **bench 进 CI 真模型回归** | ❌ | `ci.yml` 只有 lint / tsc / test / Playwright e2e；没有 bench、没有真模型回归 | 自研 CI 门 |
| 可复用的观测构件 | ✅ | **Debug panel**：`GET /api/agent/debug` + `lib/debug-snapshot.ts` + `components/DebugPanel.tsx`（`ed041eed`、`3a01952c`、`e368baf3`、`b5acfe87`）；会话统计/成本/耗时的 UI 增强（`b9664048`、`972b02dd`、`653cd7c0`、`49fa89c9`） | Debug panel 做 MVP；统计增强按需 |

### 2.6 环境（§9.2）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **离线依赖 vendor（L1–L5）** | ❌ | Docker 镜像带 bash/git，`PI_OFFLINE` 只关闭模型目录/插件联网检查；**没有依赖 vendor、离线 pip/npm 安装、会话 bootstrap** | 按 `agent-environment-dependencies.md` 自研 |
| 可复用构件 | 🟡 | Dockerfile / compose（`e97d00b1`）提供可复现运行环境；`PI_OFFLINE` 可先接 | 如换容器部署再评估；`PI_OFFLINE` 可单独接 |

### 2.7 分发（§9.10）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **配置包签名 / semver** | 🟡（但概念不同） | 上游的“包”是 pi 插件（npm/git），有 `lib/plugin-updates.ts` + `semver` 做升级检查；**没有我们的配置包概念**。我们的 apkg 已有加密/许可/导入限制，反而领先 | 保留自研；不引入 |
| **市场 / 热加载** | ❌ | 无 marketplace；热加载只到扩展/设置层（`feb40f63`、`15c52bbb` 共享 extension runtime 1 小时），不是配置包热加载 | 暂缓/自研 |
| 发布流水线 | 🟡 | `publish.yml`：npm Trusted Publishing + GHCR 镜像；`16f195c6` | 与我们的 tar/AppImage/Electron 分发不同，不直接引入 |

### 2.8 运维（§9.11）

| 遗漏项 | 上游有解 | 证据与边界 | 建议 |
| --- | --- | --- | --- |
| **HA / 自动备份 / 灰度** | ❌ | 无多节点、无备份、无灰度；单进程 + `~/.pi` 数据目录 | 自研/暂缓 |
| 可复用构件 | 🟡 | Docker/compose（`e97d00b1`）；CLI `version/update/status/stop/open` + run records（`f98c0881`）；npm/GHCR 发布（`16f195c6`） | Docker 可选；CLI status/stop 可借鉴，但我们的 `start-all`/systemd 已覆盖 |

### 2.9 汇总表

| 类别 | 完整解决 | 部分/构件 | 无解或 out of scope |
| --- | --- | --- | --- |
| 运行时 | 0 | 3（codemode worker、liveness、SSE/压缩队列） | 单进程、checkpoint、bg 唤醒 |
| 记忆 | 0 | 0 | 全部 |
| 编排 | 0 | 2（side chat、subagent wait/worktree） | ACP、多根、跨项目子代理、工作流、定时 |
| 治理 | 0 | 1（trust/env 清洗） | 审计、保留策略 |
| 观测 | 0 | 1（Debug panel + 统计） | OTel、指标、CI bench |
| 环境 | 0 | 1（Docker/PI_OFFLINE） | 离线 vendor |
| 分发 | 0 | 1（插件 semver 检查） | 配置包签名/市场/热加载 |
| 运维 | 0 | 2（Docker、CLI） | HA/备份/灰度 |

---

## 3. 三个“现在就该修”的发现

### 3.1 P0：preview-mode secret 可绕过全部认证（上游 `cf3ebfba`）

**上游修复**（2026-10-08，`cf3ebfba`）：

- Next 的 `.next/prerender-manifest.json` 里带 `preview.previewModeId`；
- `next start` 收到 `x-prerender-revalidate: <previewModeId>` 时，把它当作
  on-demand revalidate，**直接跳过 middleware/proxy**（Next 源码
  `next-server.js` → `checkIsOnDemandRevalidate`，我们在本机
  `node_modules/next/dist/server/next-server.js:1126` 已确认同一逻辑）；
- 官方 npm 包发布时把 `.next` 一起打包，任何拿到包的人都能读出这个 id，
  进而绕过 `proxy.ts` 的密码门、Host/Origin/Fetch-Metadata 校验；
- 上游的修法：启动前把三个 preview secret 换成随机值
  （`bin/rotate-preview-secrets.js`，在 `bin/pi-web.js` 里 `next start` 之前调用）。

**我们的暴露面**（0851）：

- `package.json.files` 包含 `.next`；
- `scripts/package-linux.sh` 把 `$SRC/.next` 复制进 `$PKG/app/`；
- `bin/pi-web.js` 是启动入口，但 **VM 部署脚本是直接 `next start`**
  （`scripts/vm/lib.cjs`、`scripts/vm-*.cjs`、`packaging/start-all.sh`），
  所以只改 `bin/pi-web.js` 不足以覆盖 VM；
- `proxy.ts` 是 `PI_WEB_AUTH=on` 时所有 `/api` 的中央认证门。

只要构建产物被分发（tar / AppImage / Electron / npm 包），持有者就能：
1) 从 `.next/prerender-manifest.json` 读 `previewModeId`；
2) 对共享部署发 `x-prerender-revalidate: <id>`；
3) Next 跳过 `proxy.ts`，请求直达路由。
对多用户 VM 来说，这等于**任何拿到同构建包的人可绕过登录**。

**已在 VM（10.99.9.7:30141）实测**（只取 previewModeId 作请求头，不打印其值）：

```text
/                 plain=307  bypass=200   ← 认证门被跳过
/api/sessions     plain=401  bypass=401   ← 路由自身还有 requireUserIdentity
/api/webauth/me   plain=401  bypass=401
```

`/` 从“跳登录页”变成 200，已经证明 proxy 被跳过。抽查的 10 个敏感
`/api`（models/projects/sessions/skills/plugins/agents/agent-running/…）
带同一请求头仍是 401——这些路由自己有第二道身份校验，所以**当前没有直接
读到数据**；但风险仍在：

- 中央认证门（以及 Host/Origin/Fetch-Metadata 校验）确实被跳过；
- 只要有一条路由只依赖 `proxy.ts`、或未来新增路由忘了加路由级校验，
  就会直接暴露；
- `/` 与静态资源不再要求登录，钓鱼/信息收集面扩大。

**这是当前线上构建的真实暴露，不是理论风险，应尽快修。**

**已落地修法**（2026-11-03，与上游 `cf3ebfba` 同思路）：

1. **启动时轮换**（不是删除 `preview` 段）：Next 16.3.5 在 `preview` 缺失时
   `checkIsOnDemandRevalidate` 会读 `previewProps.previewModeId` 而崩溃，所以
   不能简单删段。`bin/rotate-preview-secrets.js` 每次 `next start` 前把
   `previewModeId` / `previewModeSigningKey` / `previewModeEncryptionKey`
   换成新的随机值（临时文件 + rename，保留权限）。
2. **接入所有启动路径**：
   - `bin/pi-web.js`（npm / AppImage / Electron 走的入口）；
   - `packaging/start-all.sh`（打包部署）；
   - `scripts/vm/lib.cjs` 的 `restartScript()`（VM 源码部署）；
   - `npm start` 的 `prestart`；
   - 几个 VM 直启脚本（`vm-deploy-0909`、`vm-npm-install`、`vm-firstrun-verify`、
     `vm-auth-test3`）。
3. **只读安装**：AppImage/squashfs 无法写 `.next`，脚本会打印明确警告并继续
   启动；要彻底覆盖，需要把应用解到可写目录，或改为启动前复制 manifest 到
   可写 overlay（未做）。
4. **验证**：VM 上执行轮换并重启后，`/` 无头 307、带**当前** manifest 里的
   id 200（这是 Next 的预期行为，服务端本机文件可读）；构建包/发布包里的
   **旧 id** 已被替换，不再能用于该实例。测试见
   `lib/rotate-preview-secrets.test.mjs`（6 条）。

### 3.2 P1：0851 的 lease 只 cherry-pick 了一半

**现象**：

- `lib/agent-event-stream.ts:110` 在 SSE 打开时
  `acquireSessionLivenessLease(sessionId)`；
- `lib/session-liveness.ts` 的 lease **TTL 90 秒**，并提供了
  `renewSessionLivenessLeases()`（`lib/session-liveness.ts:181`）；
- 但 0851 **没有** `app/api/agent/[id]/lease/route.ts`，`hooks/useAgentSession.ts`
  里也**没有** 30 秒续约/`visibilitychange` 续约；
- SSE 心跳每 30 秒只发 `:\n\n`（`HEARTBEAT_INTERVAL_MS = 30_000`），
  **不续 lease**。

**后果**：

- 打开一个会话后 90 秒，liveness provider 失效；
- 默认 `PI_WEB_IDLE_TIMEOUT_MS=10 分钟`时，即使标签页开着，wrapper 也会被
  idle 回收；下次命令从 JSONL 重新启动，扩展状态/后台任务丢失；
- `session_shutdown` 会杀掉该会话的 bg 任务（`bg-shell.ts` 的 shutdown 分支），
  所以“任务完成 → 自动唤醒”在会话被回收后永远不会发生；
- VM 部署常设 `PI_WEB_IDLE_TIMEOUT_MS=7 天`（`packaging/pi-web.sh:59`、
  `packaging/start-all.sh:339`），所以线上不一定马上暴露，
  但默认配置（10 分钟）和别的部署会中招。

**证据**：0851 的 `git log -- lib/session-liveness.ts` 显示
`b966a3ba cherry-pick: session liveness lease infrastructure (upstream 0ff1138, manual merge)`；
而 `0ff1138` 原始提交包含 `app/api/agent/[id]/lease/route.ts` 和
`hooks/useAgentSession.ts` 的续约 effect。**`dev` 主线已有这两块，0851 缺。**

**已落地（2026-11-03）**：

1. 新增 `app/api/agent/[id]/lease/route.ts`：带 `checkLiveSessionAccess` 归属栅栏；
   `renewSessionLivenessLeases(id)` 为 0 且 wrapper 存活时，
   `acquireSessionLivenessLease(id)` 创建 **page lease**（90s TTL），
   下一次 POST 续约。这样即使 SSE 流已关闭（idle 会话），页面仍能保活。
2. `hooks/useAgentSession.ts` 新增 `SESSION_LEASE_RENEW_INTERVAL_MS=30_000`
   effect：30 秒 POST 续约 + `visibilitychange` 可见时立即续约；不再依赖
   SSE 流保持打开，避免为了保活而长期占用浏览器 6 条连接。
3. 测试：`hooks/useAgentSession.test.mjs` 断言 30s 续约/路由栅栏/创建 lease；
   `lib/session-liveness.test.mjs` 覆盖 TTL 与续约。
4. 仍可选的后续（非必须）：
   - 按上游 `b593cd6b` 改成“每会话一个 idle 倒计时 + 页面续约”；
   - 按 `70b2947c` 做隐藏页释放 SSE（§4.2）；
   - 若要让 idle 会话持续接收扩展状态/ widget，再考虑上游“选中流常开”的行为。

### 3.3 P1：bg-shell 有“唤醒”，没有“活着等到唤醒”

`pi-config/agent/extensions/amedac-core/src/bg-shell.ts` 已经实现了：

- 任务自然退出 → `notifyTaskExit()` → `ctx.sendUserMessage(..., { deliverAs: "followUp" })`
  → 父会话起新回合（`<task-notification>`）；
- 手工 `bg_stop` / `session_shutdown` 不通知（合理）。

但任务运行期间**没有注册 session liveness provider**。一旦 wrapper 因 idle
被回收，`session_shutdown` 会 kill 本会话的 bg 任务，唤醒逻辑就没有机会执行。

**建议**（与 §3.2 配套）：

- `session_start` 时通过
  `globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")]` 注册一个 provider：
  `isActive: () => listBgTasks(sessionId).some(t => t.status === "running")`，
  `session_shutdown`/替换时 release；
- 这个契约是上游公开的（README §Extension Session Liveness），只影响自动 idle
  回收；显式 Stop / shutdown 仍然优先；
- 远程模式（sandbox/ssh/relay）同样成立：任务在远端跑，session wrapper 在本地，
  provider 只是阻止 wrapper 被回收。

---

## 4. 其他值得引入的运行时/平台构件

### 4.1 Debug panel（P1，观测）

**上游实现**：

- `GET /api/agent/debug?session=` → `buildDebugSnapshot()`（`lib/debug-snapshot.ts`）；
- 只读、同步：不启动 wrapper、不开流、不动 idle timer、不 `send()`；
- 内容：每个 wrapper 的状态/生命周期/idle 截止时间、event stream（holder、
  地址、打开时间、丢弃事件、积压字节）、子代理 run 与待通知、MCP host 状态、
  终端、文件 watch；**不含 prompt/消息/配置/env**；
- UI：`components/DebugPanel.tsx`（约 2000 行）+ 客户端采样/轮询/倒计时；
- 附带 SSE 连接计数（每页/每服务器）、页面列表、verdict/issues。

**为什么对我们有价值**：

- 50 用户 × 每人 10 会话时，最需要回答“谁占着 wrapper / 哪条流卡住 /
  这个会话还有多久被回收”；
- 我们的 agent/terminal/file-watch 三条 SSE 都吃浏览器连接池，Debug panel
  能直接暴露；
- 可作为未来 `/metrics` 的数据源。

**移植建议**：

- 先做 MVP：`GET /api/agent/debug` 返回 `{ sessions: [{ id, state, running,
  idleDeadlineAt, streams: n, queuedBytes }], totals }`；UI 只做表格 + idle 倒计时；
- 我们 `lib/rpc-manager.ts` 目前只有 `idleTimer`，需要补 `getDebugSnapshot()`
  和 lifecycle map（启动/关闭时间）；`agent-event-stream` 需要补 info 注册表；
- 子代理/MCP/终端明细可后置。整体工作量：MVP 2–3 人日，完整版 5–8 人日。

### 4.2 隐藏页释放空闲 SSE + 单 idle 倒计时（P1/P2）

- `70b2947c`：页面隐藏 30 秒后，若无 run/queued/compaction/扩展对话框/
  未结子代理，就释放该会话的 SSE；页面回来或 lease 回复显示有活动时重连；
- 背景：HTTP/1.1 每个 origin 只有 6 条连接，多标签页的 SSE 会把设置、
  消息同步等请求饿死；
- 我们的 `useAgentSession` 目前没有 `usePageHidden`/lease 检查，长开的标签页会
  持续占流；
- 依赖 §3.2 的 lease 续约；建议先补 lease，再评估这一步。
- `b593cd6b` 的“每会话一个 idle 倒计时”是更彻底的重构，非必须。

### 4.3 会话列表尾部增量扫描（P1，性能）

- `1a94341c`：只解析文件新增的尾部，附带 `lib/session-list-scanner.bench.mjs`；
- 我们 `lib/session-list-scanner.ts` 已按 `(size, mtime)` 缓存，但文件变化时
  `scanSessionFileInfo(filePath)` 会**整文件重读**；活跃会话每次 prompt 都增长，
  20MB 文件约 75–150ms；
- 500 个会话的登录/刷新潮会放大这个成本；
- 建议：保留我们的索引结构，增加 `offset + 最后 entry id`，只解析新增行；
  处理截断/重写（`sed -i`、git checkout）时回退全扫；用 bench 对比。

### 4.4 压缩期间 prompt 停泊（P2）

- `a2950256`：pi SDK 拒绝“compaction 期间提交 prompt”时，wrapper 把 prompt
  停泊（`parkedDuringCompaction`），`compaction_end` 后 FIFO 放行；
  UI 显示队列行，支持 Recall/Stop；
- 我们 0851 没有这段逻辑（`grep "compaction is in progress"` 无命中），
  用户在手工压缩时发消息会被拒；
- 依赖 SDK 的拒绝文案；移植中等，建议在用户反馈后再做。

### 4.5 codemode（条件引入，依赖 pi 1.x）

- `81cc2856` + ADR 0006：pi 0.99+ 内置 `codemode`（模型写 JS 在 QuickJS 里
  调工具）、`tool-search`、`mcp` 三个扩展；Pi Web 用 SDK 工厂重建；
- `6b8005df`：`PI_CODEMODE_MAX_WORKERS` 默认 8（pi 默认 2），每 worker 256MB；
- ADR 0006 还记录了 fan-out（每个 wrapper 连接所有 MCP server）、Stop 等待、
  环境泄漏等问题及解法；
- **0851 是 pi 0.85.1，没有这些 SDK 能力**；等 pi 升级到 1.x 再评估。
  升级本身是另一个大工程（上游从 0.85→1.5 跨了很多 breaking change）。

### 4.6 MCP host（参考设计，不直接移植）

- ADR 0006 / `docs/agents/mcp-runtime.md`：per-session `McpHost`，
  `loadConfig` 返回空，自己 `registerMcpServer()`；每次 prompt 重读 trust；
  stdio 用清洗后的环境；idle 10 分钟 unregister；状态写回 Settings；
- **注意**：它仍然在 pi-web 进程内启动 stdio server，**并没有解决
  “MCP 在 Host 执行”的隔离问题**；它解决的是 fan-out、trust 时序、环境泄漏、
  Stop、状态可见性。我们的 P0 剩余项（已存在 stdio 条目/管理员模板）仍需
  执行面隔离（sandbox/relay）才能真正解决；
- 依赖 pi 1.x 的 `registerMcpServer`，0851 不可直接用；可作为我们 MCP adapter
  后续重构的参考。

### 4.7 Side chat（P2，交互）

- `3bad742d` + ADR 0007：从当前会话 fork 一个隐藏 side session，
  保留父历史、工具收窄到 `SIDE_TOOLS`（read/bash/powershell/grep/find/ls），
  用隐藏 `custom_message` 标记边界，右侧面板打开，Agents switcher 有行；
- 价值：长任务运行中“问一句题外话”，不 steer 主任务、不丢上下文；
- 依赖：会话 fork（我们已有）、`custom_message`（pi 0.85.1 可能有）、
  工具 allowlist、右侧面板（我们有 AgentSessionPanel 可复用）；
- 工作量高（上游改了 20+ 文件），建议等明确需求再做。

### 4.8 Docker / CLI / npm 发布（P2，运维）

- `e97d00b1`：Dockerfile（node 用户、bash/git）、compose（agent 数据卷、
  workspace 卷）、GHCR 发布、`docs/docker.md`；
- `f98c0881`：`pi-web version/status/stop/open/update` + run records；
- `16f195c6`：npm Trusted Publishing；
- 我们的分发是 tar/AppImage/Electron + `start-all.sh` + `version.json`/app-update，
  与上游 npm 渠道不同。**除非要支持容器化部署，否则不建议整包引入**；
  `pi-web status/stop` 的多实例 run record 思路可借鉴到我们的运维脚本。
- `PI_OFFLINE`（模型目录/插件检查离线）可单独接，服务于离线环境。

---

## 5. UI 可引入清单

> 说明：上游侧栏在 2026-10-07～10-10 经历了一次大重构（15 个 feat(sidebar)），
> 设置页也有独立的响应式/移动端重构。我们 0851 的 `SessionSidebar` /
> `ProjectSessionTree` / `SettingsPanel` 是自研的（项目/会话树、Host 注册表、
> 五模式、平台多用户），**整包引入会直接冲突**。下表只列可低耦合搬运的行为/组件。

### 5.1 A 类：低风险、建议引入

| 功能 | 上游提交 | 0851 现状 | 说明 |
| --- | --- | --- | --- |
| favicon 待输入/未读角标 | `0b1eeffa` | 无（只改 `document.title`） | 后台标签页完成/等待输入时可见；依赖侧栏计数 |
| Git 变更 Tree/List 切换 | `2251c3fa` | 有 Git 变更列表/徽标，无视图切换 | 纯前端 |
| CSV/TSV 表格预览 | `f87afbbe` | 无 | FileViewer 加一种渲染 |
| SVG 代码块预览 | `377c0125` | 无 | MarkdownBody 的 fence 渲染 |
| 公式复制按钮 | `5e2d92dd` | 无 | KaTeX 块加按钮 |
| 正文文件默认换行 | `f07f3682` | 默认不换行（可切换） | 改默认值即可 |
| 附件按钮支持任意文件 | `3f6baa90` | 只支持图片 | 非图片走“上传到工作目录 + @ 提及”，复用现有拖拽/上传逻辑 |
| 模型图片尺寸上限 | `ec9f38ae` | 无 | 需 SDK model 字段支持则加 |
| 自定义模型自适应思考 | `f0b3117e` | 有 `thinkingLevelMap`，无 adaptive 开关 | 视 SDK 能力 |
| 按模型 Base URL 覆盖 | `dd8201b9` | 已有 provider 级 `baseUrl` | 可加 per-model 覆盖 |
| provider/model 搜索匹配 id | `df163cdb` | 可能只匹配 name | 小改 |
| PWA 运行时应用名 | `2adb1855` | manifest 静态 `amedac.ai WebUI` | `PI_WEB_APP_NAME` 思路可接 |
| 终端主题切换 | `520ce8d5` | 无 | WorkspaceTerminal 固定主题 |
| 终端字号跟随聊天 | `35af7102` | 固定 13px | 小改 |
| 手机 Termux 风格扩展键 | `68353265` | 无 | 触屏终端增强 |
| 会话在新标签页打开 | `5e286a94` / `d9adb386` | 无 | 项目/会话菜单加一项 |
| 项目显示名重命名 | `ee78105d` | 已有 Host 目录重命名；项目重命名待确认 | 复用现有 rename 输入 |
| 项目手动排序 | `02ded7ef` | 无 | 需要持久化顺序 |
| 删除项目全部会话 | `c8182b18` | 无 | 二次确认 + 保留运行中 |
| 归档批量操作 | `49c9ca84` | 无归档概念 | 需先有 archive |
| 扩展状态链接新标签页打开 | `6a5c02f0` | 无 | 一行 target=_blank |
| 压缩摘要默认折叠 | `47d8b9a4` | 待确认 | 我们可能已折叠 |
| 自定义消息按 header 折叠 | `574cbba1` | 待确认 | 小改 |
| 工具平铺参数按行显示 | `083fd11b` | 待确认 | 中改 |
| 引用选中文本（Quote） | `6d0946b1` | 已有 quoted branch/quote | 对齐行为即可 |
| 聊天内联音频/视频 | `51b11598` | FileViewer 有，聊天内待确认 | Markdown 渲染扩展 |

### 5.2 B 类：中风险/较大，按需评估

| 功能 | 上游提交 | 评估 |
| --- | --- | --- |
| Debug panel | `ed041eed` 等 | 高价值，但组件 2000 行、依赖 wrapper/流注册表；建议做 MVP（§4.1） |
| 隐藏页释放 SSE | `70b2947c` | 依赖 lease 续约；先修 §3.2，再评估 |
| 单 idle 倒计时重构 | `b593cd6b` | 更彻底，非必须 |
| 消息轮次耗时 | `49fa89c9` | 依赖 pi 记录 `durationMs`（1.1+）；0851 需用文件时间戳近似 |
| 用量明细/平均输出速度 | `b9664048` | 我们已有 usage 行/tps，可增量改 |
| cache/cost notices | `653cd7c0` | 依赖 pi 1.x 事件；0851 不可直接用 |
| 子代理行显示模型/思考/成本/耗时 | `6c9dbbe3` / `972b02dd` / `4b529b4d` | 我们是 tintinweb runtime，数据形状不同；需先确认能拿到 |
| Agents 顶栏徽标 | `fbcbc316` | 我们有 AgentSessionPanel，可加计数 |
| 模型 scoped/all 切换 | `14c0c947` | 需 `/api/models` 支持 scope；我们已有 enabled models 概念，可评估 |
| 手机设置逐级导航/全屏 | `9afc5084` / `1420b817` / `16153474` / `57078bb5` | 我们已有 mobile section picker，部分覆盖；差异需 UI 评审 |
| side chat | `3bad742d` | 高工作量；交互价值明确，但依赖较多 |
| 新会话项目/worktree 选择条 | `bb51acad` 等 | 我们的向导/项目树不同，跳过 |
| 主题扩充（4→12） | `d749fadf` | 需 UI 设计决策，非纯技术 |
| 设置自定义字体/字重 | `86d94e22` | 与我们的设置页样式族不同，暂缓 |

### 5.3 C 类：不建议引入

| 内容 | 原因 |
| --- | --- |
| 上游侧栏重构（project groups / Sessions·Files split / 拖拽排序 / 28px 行高等） | 与 0851 的 `ProjectSessionTree`（项目/会话、Host 组、五模式）结构冲突，重写成本大于收益 |
| 上游设置页整页重构 | 我们已完成设置大修（分组/tab/滚动/移动端），再套会回退 |
| 上游 demo / GitHub Pages / PWA 截屏 | 与产品无关 |
| npm 发布链路 | 我们的分发是 tar/AppImage/Electron，渠道不同 |
| 上游 subagent runtime / MCP host | 依赖 pi 1.x 与自研 runtime，移植等于重写 |

---

## 6. 建议顺序

### P0（本周，安全/正确性）

1. ✅ **preview-mode secret**：启动路径轮换 + 所有 launcher 接入 + 测试（§3.1）。
2. ✅ **补齐 lease 续约**：`lease/route.ts`（含 page lease）+ 30s effect + 测试（§3.2）。
3. ⬜ **bg-shell liveness provider**：任务运行期间阻止 idle 回收（§3.3）。

> 2 和 3 一起做，才能让“后台任务完成 → 自动唤醒”在默认 10 分钟 idle 配置下成立。

### P1（2–4 周）

4. **Debug panel MVP**：会话/流/idle 三块，先解决“谁占着会话”的运维盲区（§4.1）。
5. **隐藏页释放 SSE**：在 lease 修好后做（§4.2）。
6. **会话列表尾部扫描**：bench 对比后替换（§4.3）。
7. **A 类 UI 批次**：favicon 角标、任意文件附件、Git Tree/List、CSV/SVG/公式/换行、
   PWA 应用名、终端主题/字号（§5.1）。
8. **会话树操作**：新标签页打开、项目重命名/排序、删除全部会话/批量归档（§5.1）。

### P2 / 暂缓

9. side chat（§4.7）。
10. codemode / MCP host（等 pi 升级，§4.5/§4.6）。
11. Docker/CLI（等部署形态变化，§4.8）。
12. 审计、保留策略、OTel、HA/备份、离线 vendor、配置包市场：**上游无解，全部自研**，
    按 [agent-framework-review.md](./agent-framework-review.md) §10 的 P1/P2 推进。

---

## 7. 与现有框架检视文档的对应

| 本文 | [agent-framework-review.md](./agent-framework-review.md) | 上游结论 |
| --- | --- | --- |
| §2.1 | §9.1 / §9.1b 执行与调度 | 无完整方案；codemode/liveness 是局部构件 |
| §2.2 | §9.5 记忆与知识 | 无；维持搁置 |
| §2.3 | §9.6 编排与协议 | 无 ACP/多根/跨项目/工作流；side chat 可参考 |
| §2.4 | §9.7 治理与审计 | 无审计/保留；trust/env 清洗可参考 |
| §2.5 | §9.8 可观测与评测 | 无 OTel/metrics/CI bench；Debug panel 可用 |
| §2.6 | §9.2 环境与依赖 | 无离线 vendor；Docker/PI_OFFLINE 局部可用 |
| §2.7 | §9.10 分发与扩展生态 | 无配置包签名/市场；插件 semver 已有 |
| §2.8 | §9.11 部署与运维 | 无 HA/备份/灰度；Docker/CLI 可选 |

---

## 8. 附录：关键提交索引

### 8.1 运行时 / 平台

| 提交 | 日期 | 内容 |
| --- | --- | --- |
| `cf3ebfba` | 2026-10-08 | **安全**：启动时轮换 preview-mode secrets，关闭 proxy 认证绕过 |
| `0ff1138` | 2026-09-11 | 选中会话保活（lease route + 客户端续约）；0851 只 cherry-pick 了一半 |
| `b593cd6b` | 2026-10-29 | 每会话一个 idle 倒计时；lease 续约重置 |
| `70b2947c` | 2026-10-20 | 隐藏页 30s 后释放空闲 SSE，活动时重连 |
| `ed041eed` | 2026-10-29 | 只读 Debug panel + `GET /api/agent/debug` |
| `3a01952c` / `e368baf3` | 2026-10-29 | Debug：页面列表 / 每页 SSE 计数 |
| `1a94341c` | 2026-10-15 | 会话文件尾部增量扫描 + bench |
| `a2950256` | 2026-10-29 | 压缩期间 prompt 停泊与 FIFO 放行 |
| `81cc2856` / `6b8005df` | 2026-10-09 / 10-29 | codemode 子代理支持 / `PI_CODEMODE_MAX_WORKERS=8` |
| `3bad742d` | 2026-11-02 | side chat（ADR 0007） |
| `e97d00b1` | 2026-11-02 | Dockerfile / compose / GHCR |
| `f98c0881` | 2026-10-10 | CLI `version/update/status/stop/open` + run records |
| `16f195c6` | 2026-10-29 | npm Trusted Publishing + 发布流水线 |

### 8.2 UI

| 提交 | 内容 |
| --- | --- |
| `0b1eeffa` | favicon 待输入/未读角标 |
| `2251c3fa` | Git 变更 Tree/List |
| `f87afbbe` | CSV/TSV 表格预览 |
| `377c0125` | SVG fence 预览 |
| `5e2d92dd` | 公式复制按钮 |
| `f07f3682` | 正文文件默认换行 |
| `3f6baa90` | 附件按钮支持任意文件 |
| `ec9f38ae` | 模型图片尺寸上限 |
| `f0b3117e` | 自定义模型自适应思考 |
| `dd8201b9` | 按模型 Base URL |
| `df163cdb` | provider/model 搜索匹配 id |
| `2adb1855` | PWA 运行时应用名 |
| `520ce8d5` / `35af7102` / `68353265` | 终端主题 / 字号跟随 / Termux 扩展键 |
| `5e286a94` / `d9adb386` | 项目/会话在新标签页打开 |
| `ee78105d` / `02ded7ef` | 项目重命名 / 手动排序 |
| `c8182b18` / `49c9ca84` | 删除项目全部会话 / 归档批量操作 |
| `6d0946b1` | Quote 只引用选中文本 |
| `51b11598` | 聊天内联音频/视频 |
| `49fa89c9` | 轮次耗时 |
| `b9664048` | 用量明细/平均输出速度 |
| `653cd7c0` | cache/cost notices |
| `6c9dbbe3` / `972b02dd` | 子代理行模型/思考/成本 |
| `14c0c947` | 模型 scoped/all 切换 |
| `9afc5084` / `1420b817` / `16153474` / `57078bb5` | 手机设置/移动端 |
| `d749fadf` | 更多主题 |

> 查证方式：`cd pi-web && git show <hash>`；
> 本文所有“上游有/没有”的判断基于 `upstream/main` 全树 grep，
> 不只 commit subject。
