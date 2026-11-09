# pi-web 负载测试工具链（dev 批次5）

三件套（零依赖，Node ≥ 22）：

| 脚本 | 作用 |
|---|---|
| `mock-model-server.mjs` | OpenAI 兼容模拟模型（流式 SSE + 工具调用），**全局预算公平分享**令牌调度：`rate = min(cap, active<=6 ? cap : floor(budget/active))`，默认 budget 300 tok/s / cap 80 → 6 流各 80、20 流各 15、100 流各 3，与真实供应商两个标定点一致 |
| `setup-mock-provider.mjs` | 把 mock provider 写进 `~/.pi/agent/models.json`（api=openai-completions，自动备份 .bak） |
| `load-run.mjs` | 压测驱动：平台批量建号 → 每用户 pi-web 登录 → 每用户 N 会话（SSE 消费 + prompt 循环 + 真实 bash 工具轮）→ 金丝雀探针（running/sessions/debug 延迟分位 + 内存/事件循环采样）→ JSON+md 报告；`cleanup` 子命令清理测试账号 |

## 本机链路冒烟（5 用户 × 2 会话）

```bash
# 1. 平台认证指向 VM 常驻沙盒平台（本机 dev 启动，端口写死 30141）
export PI_WEB_PLATFORM_URL=http://10.99.9.7:3000
npm run dev &

# 2. 起模拟模型（默认 127.0.0.1:3099）
node perf/mock-model-server.mjs &

# 3. 注册 mock provider（写入本机 ~/.pi/agent/models.json）
node perf/setup-mock-provider.mjs

# 4. 跑负载（平台 admin 密码见 scripts/vm-credentials.cjs）
node perf/load-run.mjs --users 5 --per-user 2 --duration 300 --tokens 300 \
  --admin-pass <ADMIN_PASS> --mock-base http://127.0.0.1:3099

# 5. 清理测试账号
node perf/load-run.mjs cleanup --admin-pass <ADMIN_PASS>
```

## VM 正式压测（50 用户 × 2 会话）

```bash
# 1. 部署当前分支（会与用户确认时机）
node scripts/vm/vm.cjs deploy --branch dev-0.85.1

# 2. 在 VM 上起 mock 模型并注册 provider（SSH：scripts/vm/vm.cjs probe '<shell>'）
#    node perf/mock-model-server.mjs --port 3099 &
#    node perf/setup-mock-provider.mjs --base-url http://127.0.0.1:3099/v1
#    重启 pi-web（使 provider 生效：会话启动时重读 models.json）

# 3. 本机驱动，指向 VM 实例（--cwd 用 VM 上存在的目录）
node perf/load-run.mjs --users 50 --per-user 2 --duration 900 --tokens 300 \
  --base http://10.99.9.7:30141 --cwd /tmp \
  --admin-pass <ADMIN_PASS> --mock-base http://10.99.9.7:3099 \
  --out perf-vm-50x2.json
```

### 提示词协议（驱动 mock 行为）

回合消息内嵌指令：`MOCKLEN:<n>`（回复 ~n tokens）、`MOCKTOOL`（先发 `bash echo` 工具调用由 SDK 真实执行，工具结果回来后下一请求输出终稿文本）、`MOCKMARK:<tag>`（首 token 打标记便于对账）。

### 观测点

- 报告：回合时长与金丝雀 p50/p95/p99、错误数、每会话统计、进程内存/事件循环 p95/解析队列/内存守卫采样、mock 并发流与速率。
- 运行中：`GET :3099/stats`（mock 并发/速率）、`GET :30141/api/agent/debug`（admin，进程指标）。
- 服务端文件日志：`<dataDir>/logs/server-YYYYMMDD.log`（背压断流/内存逐出/恢复排队都有打点）。

## 40G 生产环境调参基线

| 环境变量 | 测试 VM 默认 | 40G 建议 | 说明 |
|---|---|---|---|
| `NODE_OPTIONS` | — | `--max-old-space-size=24576` | 守卫阈值自动跟随 heap 上限（70%） |
| `PI_WEB_MAX_LIVE_SESSIONS` | 400 | 600 | 全局活会话上限（50 用户×2 的 4 倍余量起） |
| `PI_WEB_MAX_SESSIONS_PER_USER` | 8 | 8 | 每用户活会话上限（admin 豁免） |
| `PI_WEB_SESSION_HEAP_GUARD_MB` | auto（70% heap limit） | auto | 0 关闭；显式 MiB 覆盖 |
| `PI_WEB_SSE_BACKLOG_LIMIT_BYTES` | 16MB | 16MB | 单连接 SSE 积压上限 |
| `PI_WEB_PARSE_WORKERS` | 2 | 4 | 大文件恢复解析线程数 |
| `PI_WEB_BATCH_USER_MAX_CONCURRENT` | 4 | 按需 | 批量 API 每用户并发（既有） |
