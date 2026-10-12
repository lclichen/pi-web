# QA 实机自动化测试流程（L2 Runbook）

> 目的：让一个**无人值守的 QA Agent**（`qa-e2e-tester` 子智能体，或任何具备
> bash + 浏览器能力的编码 Agent）能在 VM 实机上独立完成部署验证、打包验证、
> 功能回归与安全回归，并产出**证据化、可对账**的测试报告。
>
> 本文只定义「实机上怎么跑」（阶段、命令、判据、证据）。用例分层与 L0/L1/S/M
> 清单见《全流程测试方案.md》；UI 手工走查对照见《平台功能检查手册.md》。
> 三者关系：方案=清单，手册=人工走查，**本文=Agent 可执行规程**。

## 0. Agent 执行契约

### 0.1 铁律（继承 qa-e2e-tester，违反即任务失败）

1. **只测试、只报告**：不修代码、不改配置、不写数据库、不建 git 提交。
2. **不破坏**：只删自己创建的一次性测试数据（用例标注「用后删除」者）；
   对既有项目/会话/用户一律只读或按用例步骤做可逆操作。
3. **证据先行**：每个判定必须有证据文件；无证据的 PASS 视为未执行。
4. **不越权**：只访问本文给出的地址与账号。

### 0.2 执行模型

- **阶段门控**：`PRE` 全过才能继续；`PRE` 失败→执行 §2.1 清理→复检一次→
  仍失败即 ABORT 出报告。其余阶段失败**记录后继续**（收集完整失败面），
  但标 ABORT 的用例后缀阶段跳过并在报告注明跳过原因。
- **重试纪律**：网络类失败（curl 超时/SSH 断开）原样重试 1 次；两次都失败才判
  FAIL，两次输出都留证据。
- **超时纪律**：单条 SSH 命令 ≤10min（打包/构建类 ≤30min）；单用例 curl
  ≤30s；真实模型回合 ≤5min（轮询 `/api/agent/running` 直到缺席）。
- **长任务姿势**（SSH 通道会挂）：远程长命令一律
  `timeout NNN bash x.sh > /tmp/log 2>&1; cat /tmp/log`，不要裸跑交互命令。

### 0.3 输入（调用方必须提供，缺一即问，不要猜）

| 项 | 说明 |
|---|---|
| VM 地址 | `10.99.9.7`（SSH 凭据见 `pi-web/scripts/vm-credentials.cjs`，gitignored） |
| 测试范围 | 冒烟集 / 标准集 / 发布集（§1），或显式用例编号列表 |
| 待测代码 | 已推送的分支（VM 部署只认 origin/dev；未推送提交先让调用方处理） |
| 证据目录 | 如 `~/qa-evidence/<日期>-<范围>/`，用例产出全部落这里 |
| 报告路径 | `<证据目录>/report.md`（§9 格式） |

### 0.4 环境事实（2026-10 校准）

- VM：`10.99.9.7`，用户 `llmx`；node 在 `/home/llmx/tools/node/bin`。
- 实机栈：pi-web `~/amedac/pi-web`（:30141）、平台 `~/amedac/sandbox-platform`
  （:3000）、relay（:30142，随 pi-web 起）、agentgateway 可选（127.0.0.1:4001，
  admin :15001）。
- 账号：`admin`（管理员）/ `test`（普通）；密码在凭据文件。
- 磁盘 ~19G 常年紧张，打包周期需 **≥4G 空闲**（§2.1 清理可回收 ~3.5G）。
- tintinweb 子智能体包安装于 `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents`
  （上游 npm 版）；测 fork 改动需按 §7 F-05 同步 dist。

## 1. 范围与触发集

| 集 | 组成 | 适用 |
|---|---|---|
| 冒烟集 | PRE + DEP + F-01/02 | 日常小改、例行巡检 |
| 标准集 | 冒烟 + PKG-01/02 + F 全部 + SF 全部 | 功能改动、发版前 |
| 发布集 | 标准 + L0（本地）+ PKG-03（+04 若磁盘≥6G）+ V 全部 | 打包/平台/权限/升级链改动 |

改动面判级沿用《全流程测试方案》§5；触及 agentgateway/子智能体/教学开关的，
对应 F-05/06/07 必跑。

## 2. PRE 预检阶段

### 2.1 磁盘（PRE-01）

```bash
df -h / | tail -1          # avail < 4G 时执行清理后复检
# 清理（安全项，全部可重建）：
rm -rf ~/amedac/pi-web/build ~/amedac/pi-web/.next
rm -f  ~/amedac/pi-web/dist/*.tar.gz
npm cache clean --force
rm -rf /tmp/appimage_extracted_* /tmp/pkg-layout-test
```

判据：清理后 avail ≥ 4G。仍不足 → ABORT（报告附清理前后 df 输出）。

### 2.2 版本指纹（PRE-02）

```bash
cd ~/amedac/pi-web && git fetch origin dev 2>&1 | tail -1 && git log --oneline -1 origin/dev
cat version.json
```

证据：`evidence/PRE-02.txt`（指纹三行：origin/dev SHA / version.json / 本地 HEAD，
若 local ≠ origin/dev 记录差异）。判据：origin/dev 存在且等于调用方声明的待测 SHA。

### 2.3 凭据与账号（PRE-03）

本地 `node scripts/vm-connection.cjs`（探活）；VM 上 admin 登录探活（§5 F-01
的错密码/对密码各一次）。判据：SSH 通、admin/test 均可登录。

### 2.4 现网服务健康（PRE-04）

```bash
ss -tln | grep -E '30141|3000|30142'      # 记录在跑/下线状态（下线不算失败，DEP 会拉起）
curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:30141/       # 在跑时 200
curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3000/health  # 平台健康
```

## 3. L0 本地静态/单元（仅发布集）

在**本地仓库**（与 VM 待测 SHA 一致）执行：

```bash
npx tsc --noEmit                                   # 0 错误
npm test                                           # ⚠ 会并行挂死，禁止整跑
# 逐文件跑（幂等且可对账）：
for f in $(git ls-files '*.test.mjs'); do node --experimental-strip-types --test "$f" || echo "FAIL: $f"; done
```

判据：tsc 0 错误；失败文件集合 ⊆ §11.2 基线。**新增失败=回归**，报 P1。

## 4. DEP 部署阶段

| 编号 | 步骤 | 命令 | 判据 |
|---|---|---|---|
| DEP-01 | 恢复 devDeps（若上次是打包后现场） | `node scripts/vm-npm-install.cjs` | 退出 0 |
| DEP-02 | 部署 dev + 重启 pi-web | `node scripts/vm-deploy-0909.cjs` | BUILD-OK；:30141 home=200；/api/quick-templates=200 |
| DEP-03 | 平台拉起（仅当 PRE-04 显示下线） | 见下 | /health=200 |
| DEP-04 | 冒烟会话（真实模型） | `node scripts/vm-smoke-session.cjs` | SMOKE-PASS（assistant 文本非空；settle ≤5min） |

DEP-03 平台启动（服务下线时）：

```bash
# SSH 内执行；结果落文件再 cat
cd ~/amedac/sandbox-platform
set -a && . ~/amedac/platform.env && set +a
setsid nohup npm start > ~/amedac/platform.log 2>&1 < /dev/null &
sleep 5 && curl -s -m 5 http://127.0.0.1:3000/health
```

DEP-04 说明：脚本流程 = admin 登录 → `POST /api/agent/new`（host 模式，cwd=
`~/lab-demo-web`，ensure_session）→ prompt → 轮询 running 缺席 → 读会话文件断言
assistant 文本非空。**它依赖 VM 上可用的真实模型配置**；模型不可用时报 P0 并
在报告注明（环境问题与产品问题分开标注）。

## 5. PKG 打包与升级链

| 编号 | 用例 | 命令 | 判据 |
|---|---|---|---|
| PKG-01 | tarball 构建 | `node scripts/vm-build-pkg.cjs` | BUILD-OK；dist 新 tarball；version.json/pkg-kind 输出正确；apply-update.cjs 与 app/version.json 存在 |
| PKG-02 | 布局与数据落位 | `node scripts/vm-pkg-layout-test.cjs`（glob 取最新 tarball，独立端口 32100/32141） | start-exit 0；config/run/logs/data 落 `$HOME/.local/share/amedac`；PKG/data 干净；二跑 start-all 幂等；web 200 或 307（未登录重定向） |
| PKG-03 | catalog 自更新循环 | `node scripts/vm-update-e2e.cjs` | updateAvailable → apply → 版本变新；admin 密码不变（数据回迁成功） |
| PKG-04 | WITH_TEACHING 双形态（磁盘≥6G） | `WITH_TEACHING=0` 与 `=1` 各跑一次 package-linux.sh | 包内 pkg-teaching 标记与 piweb.env 播种行随参数翻转 |

注意：PKG 阶段会 git reset 主树并在 `build/package-linux` 暂存构建（约占
2G）；跑完 PKG-01/03 后主树 node_modules 可能缺 devDeps——**DEP-01 必须先于
DEP-02**。tarball 文件名取 package.json 版本（0.9.0），与 version.json
（0.0.1-alpha）不同源，布局脚本已按 glob 取最新，勿按文件名硬编码。

## 6. FUNC 核心功能实机用例（需 DEP 全过）

登录态拿取（后续复用）：

```bash
COOKIE=$(curl -s -m 10 -c - -X POST http://127.0.0.1:30141/api/webauth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"***"}' \
  | grep pi_web_sid | awk '{print $7}')
```

| 编号 | 用例 | 步骤要点 | 判据 |
|---|---|---|---|
| F-01 | 认证往返 | 错密码→401；对密码→200；GET /api/webauth/me | 三态正确；me 返回 admin |
| F-02 | 会话空间隔离 | admin 与 test 各自登录 → GET /api/sessions | admin 见 host 空间；test 只见自己分片，无 host 会话 |
| F-03 | 项目 CRUD | POST /api/projects（sandbox）→ GET → PUT 改名 → DELETE（用后删除） | VM 平台有镜像时创建成功；四步往返一致 |
| F-04 | 快速模板持久化 | POST /api/quick-templates（含 provider+modelId 成对）→ GET | 保存后 modelId 在列；**只填一半的保存被拒** |
| F-05 | 子智能体 e2e | 见 §6 专节 | 嵌套+viewer 双断言 |
| F-06 | 教学开关 | PATCH /api/server-settings `{"labTraining":false}` → 新会话 → 恢复 true | off：会话 entries 无 remote-verify 桥、无 lab 自定义消息；on：恢复。开关往返不残留 |
| F-07 | 网关归因（可选） | gateway 在线时发一条消息 → 查网关 request logs（admin :15001） | 日志行含正确的 agentgateway_user / session 归因列 |
| F-08 | 侧栏分组数据面 | GET /api/sessions（admin） | 本地/沙盒项目会话的 mode 正确解析；Host badge 仅 host 模式会话（`s.mode==="host"`）；无 "unknown" 堆积（若有，记 P2 并附 sessionId 列表） |

F-06 可观测点：off 时创建的会话文件中不应出现 `__piWebRemoteVerify` 字样
（`grep -c __piWebRemoteVerify <session-file>` = 0），on 时 ≥1。开关操作前后
都要 `GET /api/server-settings` 留证。

## 7. F-05 子智能体 e2e（tintinweb fork）

前置：本用例测的是 **fork**（`lclichen/tintinweb-pi-subagents`，分支
`port/206-on-v0.19`）的行为——上游 npm 包没有 sessionId 透传与会话目录对齐。

### 7.1 fork 同步到 VM（每次跑前做一次）

```bash
# 本地（fork 仓库，npm run build 已产出 dist/；tsc 的 1 个既有报错不影响产物）：
cd tintinweb-pi-subagents && tar czf /tmp/tt.tgz dist src package.json
# 上传（scp/sftp 均可，密钥同 VM）后解到安装位：
scp /tmp/tt.tgz llmx@10.99.9.7:/tmp/
ssh llmx@10.99.9.7 'tar -xzf /tmp/tt.tgz -C ~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents'
# 重启 pi-web（jiti 进程内缓存会保留旧代码）——DEP-02 的重启段即可，无需 build
```

**必须同步 `src/`，不能只覆盖 `dist/`**（2026-10-12 实测踩坑）：该包没有
`main`/`pi.extensions` 入口声明，pi 的包加载器做目录发现时 **`<pkg>/src/index.ts`
（jiti 现场编译）优先于 `<pkg>/dist/index.js`**——只换 dist 时运行时仍编译旧
src，所有 fork 改动静默失效（工具照常工作，行为却是上游的）。

注意：fork 与上游同名同版本（`@tintinweb/pi-subagents@0.19.0`），`npm update` 会
把 fork 覆盖回上游——同步以整包覆盖为准，勿在 VM 上重装该包。同目录下的
`pi-subagents.upstream-bak` 是历史备份，不会被加载（node_modules 内不做自动
发现），留着无害。

### 7.2 用例步骤

1. admin 登录，host 模式新会话（cwd=~/lab-demo-web）。
2. prompt 诱导 spawn（subagent_type 显式给 general-purpose，否则模型可能
   自选 Explore 等 profile——断言 A 与 profile 无关，但复现要稳定）：
   `请用 Agent 工具启动一个 subagent_type=general-purpose 的子智能体，
   任务：列出当前目录的文件并在最后回复"DONE"。等待它完成并汇报结果。`
3. 轮询 `/api/agent/running` 直至缺席（≤5min）。
4. **断言 A（嵌套）**：`GET /api/sessions` 中出现子会话——
   - `parentSessionId` = 父会话 id；
   - `relation.kind === "subagent"`（`#id8` 命名识别生效）；
   - `name` 形如 `<Type>#<8hex>`。
5. **断言 B（viewer 数据面）**：`GET /api/sessions/<子id>/context` 200 且
   entries 非空（SubagentViewer 右面板即读此接口）。
6. **断言 C（父会话工具结果）**：父会话文件中 Agent 工具结果含
   `sessionId` 字段（fork 新增透传）。
7. （有视觉能力时）UI 断言：侧栏子会话嵌套在父会话下、Agent 卡片可开右面板
   viewer 标签页——截图两判定为 P2。

### 7.3 清理

子会话与父会话都是测试产物：测完通过 UI/API 删除，或在报告中列出 sessionId
交由调用方决定（默认保留供人工复核时，须注明）。

## 8. SEC 安全实机子集

| 编号 | 用例 | 判据 |
|---|---|---|
| SF-01 | 伪造 cookie：不登录携 `pi_web_sid=forged` 打 /api/sessions、/api/terminal/create、/api/cwd/browse | 全部 401/403，无数据返回 |
| SF-02 | 跨用户会话：test 登录后访问 admin 的会话（sid 取自 admin 侧）remotefs / context | 404/403 |
| SF-03 | host 目录围栏：test 用户对 host 空间路径的 /api/files 读写 | 403 |

完整 S 系列（含 relay/平台项）在 L1 执行，见《全流程测试方案》§5a；触及对应
改动面时补跑。

## 9. UI 视觉抽检（V 系列）

> 无视觉能力的 Agent 全部记 SKIP（不算失败），报告注明。有视觉能力则截图必存
> `evidence/V-xx.png`，判读标准对照《平台功能检查手册》对应节。

| 编号 | 画面 | 关注点 |
|---|---|---|
| V-01 | 登录页 | 布局/文案/按钮横排 |
| V-02 | 主页（浅+深） | 侧栏项目分组、上下布局（项目树+文件树同屏，不折叠成 tab） |
| V-03 | 设置各 tab | 表单不溢出；模型页 SettingsUi 布局为参照 |
| V-04 | 侧栏分组 | Host badge 仅 host 会话；子会话嵌套缩进 |
| V-05 | 子智能体 viewer | 右面板标签页、状态徽标、消息渲染 |

本地 Playwright e2e（`npm run test:e2e`，自起服务+临时目录，不碰 VM）可作为
无视觉 Agent 的替代 UI 门——发布集建议两者其一必跑。

## 10. 证据与报告规范

### 10.1 证据目录

```
<evidence>/
  PRE-01.txt …           # 每用例至少一个文件（接口全文/截图/日志摘录）
  dep-pkg-build.log       # 阶段级日志（构建/打包全文）
  results.json            # 机器可读结果（下述 schema）
  report.md               # 人读报告
```

### 10.2 results.json

```json
{ "env": { "vm": "10.99.9.7", "rev": "<origin/dev SHA>", "version": "0.x.y",
           "date": "YYYY-MM-DD", "scope": "standard" },
  "cases": [
    { "id": "DEP-02", "status": "pass|fail|skip|abort",
      "severity": "P0-P3 (fail 时)", "evidence": "PRE-…/dep-….log",
      "durationMs": 0, "note": "" }
  ] }
```

### 10.3 report.md 骨架

```
# 测试报告 <日期> <范围>@VM
环境指纹: pi-web <SHA> | version.json <x> | 端口 30141/3000/30142 | 账号 admin+test
结论: PASS | PASS(含已知基线) | FAIL          — P0=0 且新失败=0 才可 PASS
## 结果总表（编号/结果/严重度/证据）
## 失败详情（每条：严重度/复现步骤/期望 vs 实际(证据摘录)/疑似层级/建议）
## 基线差异（与 §11.2 对照：新增失败、已修复基线项）
## 跳过项与原因（环境缺项/无视觉/磁盘不足…）
```

严重度沿用方案 §7：P0 主流程不可用/越权/数据丢失；P1 主流程有损有绕行；
P2 次要；P3 文案样式。

## 11. 运维事实卡（Agent 必读，防重复踩坑）

### 11.1 VM 操作

- SSH 长任务挂通道：一律 `timeout NNN bash x.sh > /tmp/log 2>&1; cat /tmp/log`。
- 杀 pi-web：`ss -tlnp | grep :30141` 取 PID 后 kill；pkill 用
  `next[-]server` 防自匹配。**SSH 远程脚本里经 JS 模板串嵌 shell 时，
  `\K` 这类转义会被吃掉一层**——PID 提取用
  `grep -oP 'pid=[0-9]+' | grep -oP '[0-9]+'` 两段式，别用 `\K`。
- **远程脚本第一行必须 `export PATH=/home/llmx/tools/node/bin:$PATH`**：
  不带 PATH 的 `setsid nohup node …` 会静默失败（nohup: node not found），
  而老进程还在听端口，表现为"重启了但改动不生效"——**用
  `ss -tlnp` 里的 PID 前后对比确认真的换了进程**。
- **同步任何扩展源码到 VM 后必须重启 pi-web**（jiti 进程内缓存）。
- **pi 包加载器入口偏好**：无 `main`/`pi.extensions` 声明的包做目录发现时
  `src/index.ts`（jiti 编译）优先于 `dist/index.js`——给已安装包打补丁必须
  src+dist 一起覆盖（§7.1 的坑）。
- 平台 `data/` 是真实数据（1.7G），**永不清理**；lab-training 实测目录
  `~/lab-demo-web`；会话在 `~/.pi/agent/sessions/users/u{id}/`（host 在根）。
- git push 从本地走代理：`git -c http.proxy=http://127.0.0.1:7890
  -c http.version=HTTP/1.1 push`。

### 11.2 已知基线（更新于 2026-10-12，跑完发布集后维护）

| 项 | 现状 |
|---|---|
| npm test 单测 | 1209 通过 / 1 失败：session-reader 子代理 relations 基线用例（需真实 tintinweb 数据，F-05 实机覆盖） |
| tintinweb tsc | 1 个既有错误（agent-runner.ts name 属性），不影响 dist 产出 |
| 管理面板 LlmTab | 字段名仍为 LiteLLM 时代的标签（契约未变，功能正常） |
| zh-TW | 部分简体占位未转繁体 |

### 11.3 本地（Windows）坑

- CRLF：仓库文件多为 CRLF；脚本改文件勿用 heredoc 拼接（字节错配）。
- **本机（8GB 内存）跑不动 `npm run build`**：webpack 在 4G 默认堆与
  8G 上限堆下都 OOM。构建验证一律在 VM 上做（DEP-02 / PKG-01）；本地只跑
  tsc + 单测。
- npm test 整跑并行挂死——逐文件（§3）。
