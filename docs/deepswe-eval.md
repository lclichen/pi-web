# deep-swe 评测接入评估与批量 API 修改方案（v2 修订）

> 2026-09-29 修订 · 评估对象：[datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe)（113 任务）× pi-web 批量测试 API
>
> **实施状态（同日，已落地）**：P0（超时接线修复 / 21 天上限 / sandbox 显式 400）✅；
> P1（批量 sandbox 接线 + toolNames 透传 + files 拒绝）✅；P1.5（任务落盘 + interrupted
> 状态 + `POST /tasks/{id}/resume` 会话重接）✅（按用户拍板选了"落盘+会话重接"）；
> 批量 API 升 **v1.3**（`docs/batch-api.md` 同步）；eval-runner MVP ✅ 位于工作区
> `../eval-runner/`（独立目录，platform + docker 双驱动，TOML 解析器对 113 任务全量
> 验证，6/6 单测过）。VM 路线按用户确认走已部署的沙盒平台。
>
> **VM 实测（同日）**：v1.3 已热同步至 VM（origin/dev 8f34a6f6 基础 + 未提交的 v1.3
> 文件，验证后应提交推送转正）；真机冒烟发现并修复**两个叠加的既有 bug**——
> ① proxy.ts 中央会话门无平台 Key 旁路，`PI_WEB_AUTH=on` 下 X-Platform-API-Key 调用
> 全被 401（v1.2 从未真机走过这条路）；② batch-auth 按平铺结构解析 `/auth/me`，而
> 平台返回 `{user:{...}}` 包裹结构，key 永远判无效。修复后 VM 冒烟全通（key 认证/
> containerId 校验/files 拒绝/21 天参数）。平台驱动机制验证通过（mock 镜像上建容器/
> exec/文件读写/停机全链路）。平台镜像名正则禁 `:`——注册约定为 docker ref 的
> `:`→`-`（eval-runner ensureImage/registerImage 已内置）。SIF 首转换在途
> （VM 出网 ~220KB/s）。待办：SIF 注册 + eval-runner 端到端 1 任务、P2 并发上限、
> 平台多设备改造（§5）。
>
> v2 变更（相对初版）：① timeoutMs 上限按长期任务需求放开到 21 天；② 撤回 SSH 模式主路线，改为**接通批量 sandbox 模式（平台原生路径）**，SSH 降为远端无平台场景的备选；③ runner 明确双容器后端（VM 功能测试 / 专用服务器 SIF 平台）；④ 新增 Docker→SIF 转换附录与平台多设备改进 backlog；⑤ 新增长期任务持久化配套项。

## 0. 结论

- **deep-swe 可以用来评估 pi-web**。它是 Harbor 任务格式的任务集（113 任务，agent 3h 断网、独立 verifier 容器、113 个 ECR 预构建 Docker 镜像，单 trial 全量 339 agent 小时），对被评对象唯一假设是"一个能在任务容器内干活的 agent"。
- 官方 runner 是 `pier`，把 agent CLI 装进容器内跑——那评的是 pi CLI。**评 pi-web 运行时**的正确形态：自建 eval-runner + pi-web 批量 API（agent 会话在 pi-web，七个编码工具经沙盒桥扩展在任务容器内执行）。
- 批量 API 已有 `mode: host|sandbox` 字段，**但 sandbox 接线是断的**（详见 §2），本期核心工作就是把它接通并修两个 bug。
- 任务容器长期由**沙盒平台（SIF）**承载；VM 只做基础功能测试（小规模），大规模评测在专用服务器。平台需补多设备资源调度（本期只留接口不实施）。

## 1. deep-swe 事实（克隆实测）

| 维度 | 事实 |
|---|---|
| 任务格式 | `task.toml`（schema 1.3）+ `instruction.md` + `environment/Dockerfile` + `tests/`（test.sh / grader.py / config.json / test.patch）+ `solution/` |
| 语言 | go 34 / python 34 / typescript 35 / rust 5 / javascript 5 |
| 环境 | 113 个预构建镜像（public.ecr.aws，匿名可拉），每任务 2 CPU / 8GB / 20GB 存储，仓库烤在 `/app` |
| agent 约束 | 全部：timeout 3h、`network_mode="no-network"` |
| 判分 | verifier 独立容器（1800s）：`[[verifier.collect]]` = `git diff <base>..HEAD > /logs/artifacts/model.patch`；补丁打到干净 base，跑 f2p/p2p 白名单测试 → `reward.json`（二值 + 明细） |
| agent 侧 | instruction 要求"新分支 + 提交全部"——容器内 git 可用（collect 自带 safe.directory） |

## 2. 现状差距

### Bug 级

1. **总超时是 no-op**（`lib/batch/task-runner.ts:245`）：`AbortController` 创建后从未接线；超时到点无法中断 `wrapper.send(prompt)`。cancel 路由的 `wrapper.send({type:"abort"})` 是正确机制。
2. **批量 sandbox 模式未接线**：`containerId` 被 `RpcSessionStartOptions` 静默忽略（无此字段）；批量路径没有注入沙盒桥扩展（正常 web 会话由 `/api/agent/new` 注入 `PI_WEB_SANDBOX_EXTENSION_PATH`，见 `lib/session-restore-options.ts:46-89` 对照）。结果：批量 sandbox 任务实际在 pi-web 服务器本机 workDir 执行。**有字段、没接线**——这就是"之前加了 mode 但感觉没用上"的原因。

### 能力缺口

3. timeoutMs 上限 1h，需支持长任务（上限 ≥21 天，默认维持 1h）。
4. 批量任务**状态不持久化**（`lib/batch/task-store.ts:140-153`，globalThis Map）：pi-web 重启后任务记录全丢。长任务（数小时～21 天）跨重启必须解决，至少任务记录落盘。
5. `toolNames` 未透传（`RpcSessionStartOptions` 已支持）——评测保真需关掉宿主侧有网工具。
6. 无服务端并发上限（fire-and-forget），大规模时需要排队兜底。
7. pi 会话 idle 回收（部署默认 7 天）会杀掉超长 batch 会话——长任务部署需调 `PI_WEB_IDLE_TIMEOUT_MS` 或 batch 会话豁免。

## 3. pi-web 修改方案

### P0 · 修 bug（先行，独立合入）

1. **超时真正生效**：timer 到点 → `wrapper.send({ type: "abort" })`（与 cancel 路由同款），send 返回后标 `stopReason:"timeout"`；删除未接线的 abortController。
2. **timeoutMs 上限放开**：默认 600_000（1h）不变；上限 `3_600_000 → 1_814_400_000`（21 天）。超过默认的值建议在响应里回显告警字段（可选）。
3. **sandbox 静默失败显式化**（过渡措施，P1 落地后收回）：无 `PI_WEB_PLATFORM_URL` / `PI_WEB_SANDBOX_EXTENSION_PATH` 配置时对 `mode:"sandbox"` 返回 400，替代"看似沙箱、实跑宿主机"。

### P1 · 接通批量 sandbox 模式（平台原生路径，deep-swe 承载面）

**请求体**（`POST /api/batch/tasks`，在现字段上扩展）：

```jsonc
{
  "mode": "sandbox",
  "containerId": 123,            // 必填：runner 预建的任务容器（平台 API 创建，保证 fresh）
  "prompt": "<instruction.md 原文>",
  "model": { "provider": "...", "modelId": "..." },
  "timeoutMs": 111600000,        // 3h + slack
  "toolNames": ["bash","read","write","edit","glob","grep","todo","plan_save"],  // 新增可选
  // ssh 模式：远端无平台场景的备选，本期不实施（接口位保留）
}
```

**task-runner 实现**（镜像 `/api/agent/new` sandbox 分支的接线，见 `app/api/agent/new/route.ts:120-150`）：

1. 为任务建独立 home（`<data>/batch-sandbox/<taskId>/`，目录形态同 `ensureProjectHome`）。
2. `writeSandboxConfig(home, { apiKey, containerId })`——containerId 经 home 的 `sandbox-platform.json` 传给桥扩展（产品同款通道，不需要动 `RpcSessionStartOptions`）。
3. `startRpcSession(sessionId, "", home, { ownerId, mode:"sandbox", initialModel, toolNames,
   additionalExtensionPaths: [PI_WEB_SANDBOX_EXTENSION_PATH],
   extensionFactories: [ makeBgTasksExtension(), makeRemoteVerifyExtension("sandbox", ownerId),
     makeEnvironmentInfoExtension({ mode:"sandbox", username }) ] })`。
   七个编码工具即经 `POST /api/v1/containers/{id}/tools/bash|read|write|edit|ls|find|grep` 在任务容器内执行——**与产品沙盒会话同一条代码路径**（这正是"评估 pi-web"的意义）。
4. `files` / `filePackagePath` 在 sandbox 模式拒绝（仓库烤在镜像里，runner 全权负责容器内容）。
5. `stopContainer` 默认 false（容器生命周期归 runner；文档注明）。
6. route 校验：containerId 必须为已存在容器（可选预检 `GET /api/v1/containers/{id}`）；toolNames 走 `validateSessionToolSelection`。

**P1.5 · 长任务配套（21 天上限的代价，需拍板范围）**

- **任务记录落盘**：task-store 加持久层（JSON 文件 per task，终态后可归档；启动时加载未终态任务并标记 `interrupted`）。最低限度。
- **会话重接**：pi 会话本身文件落盘（sessionFile），重启后可重开 wrapper 续跑——完整断点续传是既有 TODO，本期做到"重启后任务可恢复执行/至少可查询终态与产物"即可，视范围拍板。
- **idle 豁免**：batch 会话不参与 `PI_WEB_IDLE_TIMEOUT_MS` 回收（或部署文档要求调大）。

**P2 · 增强（按需）**

- 服务端并发上限 `PI_WEB_BATCH_MAX_CONCURRENT`（超出排队，state 复用 `queued`）。
- result 增补 stopReasonDetail；versions 1.2 → 1.3；`docs/batch-api.md` 同步。

## 4. eval-runner 设计（pi-web 之外，pier 对齐）

```
deep-swe-runner（node）
├── plan      解析 tasks/*/task.toml；子集采样（--n-tasks/--sample-seed 对齐 pier）
├── prep      镜像准备：platform driver=确认 SIF 已注册；docker driver=docker pull
├── run       容器创建（driver 抽象）→ POST /api/batch/tasks (sandbox+containerId)
│             → SSE/轮询至终态
├── collect   平台 tools/bash 跑 [[verifier.collect]] → tools/read 取 model.patch（base64）
├── verify    起新容器（同镜像，fresh）→ tools/write 注入 /tests + model.patch
│             → tools/bash 跑 tests/test.sh → tools/read 解析 /logs/verifier/reward.json
├── report    jobs/<run-id>/（每任务 patch/reward/logs + report.md）+ runs.jsonl
└── resume    jobs/<run-id>/state.json 阶段记录，中断跳过已完成
```

- **容器驱动抽象**（本期两个实现）：
  - `platform driver`（生产）：全部经平台 API（containers/images/tools/*），零 docker 依赖——**verifier 阶段也纯平台 API**。多设备调度未来在平台侧落地后对 runner 透明（runner 只依赖 create/exec/read/write/stop 五个动词）。
  - `docker driver`（VM 功能测试期备选）：`docker create/start/exec/cp` 直连。仅当 VM 上不便部署平台时使用；缺点是绕过了被测主路径（pi-web→平台→容器），只验证 runner 逻辑本身。
- **trial 必须 fresh 容器**：runner 自建容器并传 containerId，不走 `provisionContainerForProject`（它有复用逻辑）。
- **凭据**：runner 持平台管理员 API key（永不过期）+ pi-web 批量 API key，均在专用服务器本地。
- **容量**：迭代期 10-20 任务子集；正式全量 339 agent 小时按专用服务器并发能力排。

## 5. 沙盒平台改进 backlog（多设备，本期不实施）

- 解除 ssh 模式 / cli 模式互斥，或抽象为统一"访问通道"，容器资源池与访问解耦。
- 多主机资源调度：镜像分发（113 个 SIF）、容器放置、健康监控；对 pi-web/runner 只暴露现有 REST 面。
- 每容器网络策略（见 §6-d）：按容器开/断外网——评测 air-gap 保真的平台级答案。
- （可选）LLM 出口统一走平台 `/api/v1/llm/*` 代理，便于多设备计量与限流。

## 6. 还没被考虑到的点（v2 新增，重要）

a. **任务状态不持久化**（§2-4）：21 天上限放开前不解决，重启=丢任务。至少做任务落盘。
b. **SIF 存储不共享层**：docker 镜像分层共享，SIF 是压扁单文件——113 个镜像的磁盘占用按"全量之和"规划（转换期还需 ~2× 临时空间），不能按 docker images 的共享层表估算。
c. **容器可写性**：agent 要写 `/app`（git commit），collect 要写 `/logs/artifacts`，verifier 要写 `/logs/verifier`。平台容器的工作区挂载策略若只覆盖 `/workspace`，需要确认/扩展到 `/app` 与 `/logs`（或 runner 建容器时显式声明可写路径）。
d. **网络隔离保真**：deep-swe 要求 agent 断网；平台容器若有外网，agent 可 `pip install`/外搜——内测可接受但须记录，正式成绩需平台级网络策略（§5）。LLM 流量在 pi-web 宿主机侧=白名单等价，无问题。
e. **pi 会话 idle 回收**（§2-7）：3h 任务无碍，21 天长任务会被 7 天 idle 策略杀掉。
f. **verifier 资源计入容量**：每任务 verifier 又是一个 2c/8g 容器（≤1800s），并发评测时平台容量按 agent+verifier 双份估。
g. **榜不可直接对比**：官方榜=pier+容器内 agent；我们是 pi-web 运行时+容器内工具执行，语义等价但轨迹格式（sessionFile vs ATIF）与系统提示词栈不同，报告注明。
h. **模型限流**：并发任务的 LLM QPS/配额在专用服务器上会成为第一瓶颈（早于 pi-web 事件循环，§性能备忘 ≤50 会话无实质问题）。

## 7. Docker → SIF 转换指南（附录）

在 **Linux 主机**（VM 或专用服务器）上执行；Windows 不能直接产 SIF（WSL2 勉强可但避免双跳传输）。`singularity` 3.x 与 `apptainer` 命令同构。

```bash
# 1) 从任务 task.toml 取镜像地址
grep 'docker_image' tasks/<task-id>/task.toml
# docker_image = "public.ecr.aws/d3j8x8q7/swe-bench-202605:<ext_id>-v1.1"

# 2) 拉取并转换（public.ecr.aws 匿名可拉；--compat 提升 OCI 兼容：fakeroot、可写 tmpfs 等）
apptainer build --fix-perms <task-id>.sif docker://public.ecr.aws/d3j8x8q7/swe-bench-202605:<tag>
# 等价：apptainer pull --compat <task-id>.sif docker://...

# 私有仓库时（如需）：
# export APPTAINER_DOCKER_USERNAME=AWS export APPTAINER_DOCKER_PASSWORD=<token-or-password>

# 3) 转换后验证（每类语言抽 1-2 个）
apptainer exec <task-id>.sif sh -c 'git --version && ls /app | head'
apptainer exec <task-id>.sif go version     # go/python/node/rust 按任务语言
apptainer exec <task-id>.sif env | grep -E "^(PATH|GOROOT|NODE)"   # docker ENV 已保留

# 4) 注册到平台：Admin 后台 / POST /api/v1/images（SIF 文件路径 + 名称约定
#    deepswe/<task-id>:v1.1，与 task.toml 的 docker_image 建立映射表）
```

注意事项：

- **磁盘**：每个 SIF ≈ 压扁后的全镜像尺寸；转换期临时空间 ~2×。113 个全转前先抽 3 个（go/python/ts 各一）实测单尺寸再排盘。
- **可写性**：`apptainer exec` 默认只读 rootfs + 可写 `$HOME`（默认指向宿主 home，注意 `--contain`/显式 bind）。平台创建容器时的挂载策略决定 `/app`、`/logs` 是否可写——**这是平台侧要确认的第一件事**（对应 §6-c）。验证法：`apptainer exec --writable-tmpfs <sif> sh -c 'touch /app/.w && rm /app/.w'`。
- **ENTRYPOINT/ENV**：apptainer 把 docker ENV 翻译进容器（PATH 等工具链可用），runscript 由 ENTRYPOINT 生成——平台走 exec 通道，不依赖 runscript。
- **rootless 可行**：任务运行期不需要 root（无 apt/无特权操作），rootless 足够；个别镜像若依赖 setuid/权限再评估 `--fakeroot`。
- **命名与登记**：SIF 文件名/平台镜像名统一 `<task-id>`，runner 的 prep 阶段按 `task.toml.docker_image → 平台 imageId` 映射表查（首次登记后缓存进 jobs 元数据）。

## 8. 实施顺序（v2）

1. P0（超时接线 + 21 天上限 + sandbox 显式 400）——半天级，独立 PR。
2. P1（批量 sandbox 接线 + toolNames + 校验）+ P1.5 范围拍板（任务落盘最低限度建议必做）。
3. runner MVP（platform driver 优先）+ 3-5 任务子集在 VM 端到端跑通（VM 部署平台 + 转 3 个 SIF）。
4. 专用服务器部署（全量 SIF 转换按 §7）→ 子集真模型评测 → 迭代 → 全量。
