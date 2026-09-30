# pi-web 批量测试 API

> 版本 1.4 · 2026-09-29 · 认证方式：X-Platform-API-Key

## 概述

pi-web 批量测试 API 允许通过 HTTP 请求自动化执行 Agent 测试任务。每个任务在独立的工作目录中运行，支持 Host 模式（服务器目录）和沙盒模式（容器）。任务异步执行——提交后立即返回任务 ID，通过轮询获取状态，终态后获取完整结果；亦可用 `"stream": true` 以 SSE 流式返回（1.1 起）。**评测框架接入**（如 deepeval）：`input → prompt`、`actual_output → finalResponse`、代码类判分经产物内容端点取回文件（1.2 起，见下）。

**设计参考**：ACP (Agent Client Protocol) v2 的提交/完成分离模式——"提交成功 ≠ 任务完成"；StopReason 结构化枚举；`requires_action` 超时后自动应答（非取消）。

## 认证

所有请求需要管理员身份。两种方式：

### 方式一：平台 API Key（推荐，适合程序化调用）

```
X-Platform-API-Key: sk-xxxxxxxxxxxxxxxx
```

管理员在 pi-web 管理面板 → 用户 → 选择目标用户 → 创建 API Key（或用平台的 `/api/v1/auth/api-keys` 接口铸造）。

> 1.3 修复说明：此前 `PI_WEB_AUTH=on` 部署下，中央会话门（proxy.ts）会在批量路由
> 之前把所有无 cookie 的请求 401 掉，平台 Key 方式**实际不可用**；且批量鉴权按平铺
> 结构解析 `/auth/me`，而平台返回 `{user:{...}}` 包裹结构。两个叠加 bug 均已修复
> （proxy 对 `/api/batch/*` 做 sk_ 格式预检放行，路由内仍是完整校验权威；
> batch-auth 兼容两种响应结构）。

### 方式二：Web 会话 Cookie（适合浏览器调试）

```
Cookie: pi_web_sid=<session-id>
```

通过正常登录流程获取。

---

## API 端点

### 创建测试任务

```
POST /api/batch/tasks
Content-Type: application/json
X-Platform-API-Key: sk-...
```

**请求体：**

```jsonc
{
  // 必填：执行模式
  "mode": "host",              // "host" | "sandbox"（ssh/local-machine 暂不支持）

  // 必填（host 模式）：工作目录（服务器上的绝对路径或相对 pi-web 的路径）
  // 不存在则自动创建 + 自动信任
  // 已存在则自动加后缀（-2, -3, ...）确保干净环境
  // sandbox 模式忽略此字段——工作区在容器镜像内（见下）
  "workDir": "/data/tests/my-project",

  // 必填（sandbox 模式）：预创建的平台容器 ID
  // 七个编码工具经沙盒桥扩展路由到该容器内执行（与产品沙盒会话同一条
  // 代码路径）。容器生命周期归调用方（评测 runner）——pi-web 不创建、
  // 也不停止它。要求部署已配置 PI_WEB_PLATFORM_URL +
  // PI_WEB_SANDBOX_EXTENSION_PATH，否则 400。
  "containerId": 42,

  // 必填：初始提示词（一次性请求，无交互）
  "prompt": "Read the test files in tests/ and fix any bugs you find. Run the test suite to verify.",

  // 可选（仅 host 模式）：内联小文件（{相对路径: 内容}），写入 workDir
  // sandbox 模式下拒绝（400）——仓库烤在镜像里，容器内容由调用方负责
  "files": {
    "README.md": "# Test Project",
    "src/main.ts": "export function main() { return 42; }"
  },

  // 可选（仅 host 模式）：文件包来源（二选一）
  // "path" = 服务器上已有目录/文件的路径（如公共 fixture 目录）
  "filePackagePath": "/shared/fixtures/test-project-v1",

  // 可选：指定模型（不指定则用会话默认）
  "model": { "provider": "zai", "modelId": "glm-4.7" },

  // 可选：总超时毫秒数（默认 600000 = 10分钟，范围 30s ~ 21天）
  // 长任务（如 deep-swe 评测 3h、多天运行）直接传大值；超时到点会向
  // 会话发送 abort 强制收尾（1.3 起真正生效，此前超时不生效）
  "timeoutMs": 600000,

  // 可选：交互等待超时毫秒数（默认 300000 = 5分钟）
  // 超时后自动应答：ask_user_question → 选推荐选项；exit_plan_mode → 自动批准
  "inputTimeoutMs": 60000,

  // 可选：推理强度 off|minimal|low|medium|high|xhigh|max（不指定则模型默认）
  "thinkingLevel": "high",

  // 可选：工具白名单（字符串数组；不指定则会话默认）
  // 评测保真场景用它关掉宿主侧有网工具（deep-swe 假设 agent 断网）：
  // "toolNames": ["bash","read","write","edit","glob","grep"]
  "toolNames": ["bash", "read", "write", "edit", "glob", "grep"],

  // 已废弃：stopContainer（1.3 起 sandbox 容器生命周期归调用方，忽略）
  "stopContainer": true,

  // 可选：关联的项目 ID（记录用途）
  "projectId": 7,

  // 可选：流式返回模式（默认 false）
  // true 时不返回 202+taskId，而是直接以 HTTP SSE 流式返回任务事件，
  // 在终态 result 事件后关闭流。详见下文"流式模式（SSE）"
  "stream": true
}
```

**响应（202 Accepted，默认异步模式）：**

```json
{
  "taskId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "statusUrl": "/api/batch/tasks/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "resultUrl": "/api/batch/tasks/a1b2c3d4-e5f6-7890-abcd-ef1234567890/result"
}
```

---

### 查询任务状态（轮询用）

```
GET /api/batch/tasks/{taskId}
X-Platform-API-Key: sk-...
```

**响应（200 OK）：**

```json
{
  "taskId": "a1b2c3d4-...",
  "state": "running",           // queued | running | waiting_input | completed | failed | cancelled
  "stopReason": "end_turn",     // 终态时: end_turn | max_tokens | timeout | cancelled | refusal | error
  "summary": "I found and fixed 3 bugs...",  // 最后一条 assistant 消息前 200 字符
  "usage": {
    "inputTokens": 15420,
    "outputTokens": 2380,
    "totalTokens": 17800,
    "toolCalls": 12
  },
  "durationMs": 45230,
  "workDir": "/data/tests/my-project-2",      // 实际使用的目录（可能带后缀）
  "error": null,                  // failed 时的错误信息
  "versions": {                   // 框架与配置包版本（用于跨部署对比）
    "frameworkVersion": "0.0.1-alpha",
    "frameworkChannel": "alpha",
    "piSdkVersion": "0.85.1",
    "configBundleVersion": "4"    // null = 开发环境（未部署离线包）
  }
}
```

**状态说明：**

| 状态 | 含义 |
|---|---|
| `queued` | 任务已创建，尚未开始执行 |
| `running` | Agent 正在执行 |
| `waiting_input` | Agent 在等待用户交互（ask_user_question / exit_plan_mode 确认），超时后自动应答 |
| `interrupted` | pi-web 重启导致中断（1.3 起）。任务记录与会话文件已落盘，可 `POST /tasks/{id}/resume` 续跑 |
| `completed` | 正常完成 |
| `failed` | 执行出错 |
| `cancelled` | 被取消（手动取消或超时） |

**持久化（1.3 起）**：任务记录写入 `<数据目录>/batch-tasks/<taskId>.json`，pi-web 重启后仍可查询；
运行中的任务重启后标记为 `interrupted`（绝不假装还在跑），可通过 resume 端点恢复。

---

### 恢复中断的任务（1.3 起）

```
POST /api/batch/tasks/{taskId}/resume
X-Platform-API-Key: sk-...
Content-Type: application/json
```

**请求体（可选）：**

```jsonc
{
  // 可选：续跑提示词。缺省使用内置的"服务器重启，继续之前的任务"提示
  "prompt": "Continue where you left off and finish the task."
}
```

语义：仅 `interrupted` 状态可恢复（否则 409）。重开会话文件继续同一转录，
在原 workDir / 沙盒 home 中执行；模型、工具白名单沿用原任务记录；超时预算
按本次续跑重新计时。响应 `202 { taskId, state: "running", resumed: true }`。

---

### 获取完整结果（终态后）

```
GET /api/batch/tasks/{taskId}/result
X-Platform-API-Key: sk-...
```

**响应（200 OK，终态时）：**

```json
{
  "taskId": "a1b2c3d4-...",
  "sessionId": "batch-a1b2c3d4-lx3fm",
  "state": "completed",
  "stopReason": "end_turn",
  "finalResponse": "I analyzed the test files and fixed 3 bugs:\n\n1. Fixed off-by-one in parser.ts...",
  "usage": { "inputTokens": 15420, "outputTokens": 2380, "totalTokens": 17800, "toolCalls": 12 },
  "toolCallLog": [
    {
      "name": "read",
      "argumentsSummary": "{\"path\":\"/data/tests/my-project-2/tests/parser.test.ts\"}",
      "resultSummary": "1-150\timport { parse } from '../src/parser';\n...",
      "isError": false,
      "durationMs": 15
    },
    {
      "name": "edit",
      "argumentsSummary": "{\"path\":\"/data/tests/my-project-2/src/parser.ts\",\"old_string\":\"...\",\"new_string\":\"...\"}",
      "resultSummary": "The file has been updated",
      "isError": false,
      "durationMs": 8
    }
  ],
  "artifacts": [
    { "path": "README.md", "size": 245 },
    { "path": "src/main.ts", "size": 187 },
    { "path": "src/parser.ts", "size": 3421 }
  ],
  "sessionFile": "/data/sessions/batch-a1b2c3d4.jsonl",
  "durationMs": 45230,
  "workDir": "/data/tests/my-project-2",
  "error": null,
  "versions": {
    "frameworkVersion": "0.0.1-alpha",
    "frameworkChannel": "alpha",
    "piSdkVersion": "0.85.1",
    "configBundleVersion": "4"
  }
}
```

**非终态时返回 409：**

```json
{
  "error": "Task is still running",
  "state": "running",
  "statusUrl": "/api/batch/tasks/a1b2c3d4-..."
}
```

#### 结果字段语义（`GET /result` 与 SSE `result` 事件的 `result` 字段）

| 字段 | 类型 | 语义 |
|---|---|---|
| `taskId` | string | 任务 ID（提交时返回的原值） |
| `sessionId` | string | 服务端 pi 会话 ID（对应 sessionFile 去扩展名；服务器侧排查用） |
| `state` | `"completed" \| "failed" \| "cancelled"` | 终态（此处只会是三者之一） |
| `stopReason` | string? | `end_turn`（正常收尾）/ `max_tokens` / `timeout`（总超时被取消）/ `cancelled`（手动取消）/ `refusal` / `error`；failed 时为 `error` |
| `finalResponse` | string? | 最后一条 assistant 消息的全部文本块拼接——**LLM-as-judge 的 `actual_output`**；失败/取消可能缺失 |
| `usage.inputTokens` / `outputTokens` / `totalTokens` | number | SDK 统计的 token 用量（成本核算用）；失败可能缺失 |
| `usage.toolCalls` | number | 本任务工具调用总次数 |
| `toolCallLog[]` | array | 工具调用轨迹：`name` + `argumentsSummary`（参数 JSON 前 200 字符）+ `resultSummary`（结果文本前 200 字符）+ `isError`；`durationMs` 当前恒为 0（未统计，占位） |
| `artifacts[]` | array | 产物清单：`path`（相对 `workDir` 的 posix 路径）+ `size`（字节）。深度≤3、跳过点文件与 node_modules、上限 100 条；**内容经产物端点取回** |
| `sessionFile` | string? | 服务端会话 JSONL 绝对路径（客户端不可直接读取，留作对账） |
| `durationMs` | number? | `startedAt → endedAt` 实耗毫秒；两者齐备才有 |
| `workDir` | string | 实际使用的目录（请求路径已存在时带 `-2`/`-3` 后缀——拼产物 URL 前先读这里） |
| `error` | string? | `failed` 时的错误信息；成功时缺省 |
| `versions` | object | 框架四项版本（跨部署对齐评测口径；`configBundleVersion` 开发机为 `null`） |

### 获取产物文件内容（评测判分用）

```
GET /api/batch/tasks/{taskId}/artifacts/{path}
X-Platform-API-Key: sk-...
```

path 是 `result.artifacts[]` 里的相对路径（多级用 `/`）。**白名单围栏**：只有精确命中该任务产物清单的路径可取（扫描时已排除符号链接，清单即围栏）；仅终态任务可取。

- 响应体为文件原始字节，`Content-Type` 按扩展名（代码/文本类为 utf-8 文本，未知扩展名 `application/octet-stream`），≤2MB（超过返回 413）。
- 状态码：`409` 任务仍在运行；`404` 路径不在产物清单；`410` 文件已被清理；`413` 超过大小上限。

```bash
curl -s http://localhost:30141/api/batch/tasks/$TASK_ID/artifacts/src/parser.ts \
  -H "X-Platform-API-Key: sk-your-admin-key"
```

评测侧典型用法（deepeval 自定义 metric 内）：`input` → 提交任务的 `prompt`；`actual_output` → `finalResponse`；代码正确性判分 → 按需拉取 `artifacts` 内容交给 judge 或在评测侧执行。

---

## 流式模式（SSE）

### 方式一：创建时直接流式返回

`POST /api/batch/tasks` 请求体加 `"stream": true`，响应即为 `text/event-stream`（HTTP 200），从 `task_created` 开始按序推送事件，终态 `result` 事件后服务器关闭流。

### 方式二：订阅已有任务的事件流

```
GET /api/batch/tasks/{taskId}/stream
X-Platform-API-Key: sk-...
```

连接后**从缓冲区重放**该任务的全部历史事件（从 `task_created` 起），再继续转发实时事件，终态 `result` 后关闭。适用场景：异步提交后想改为观察进度；网络断开后重连（重连会从头重放，客户端按 `seq` 去重即可）；对已结束任务一次调用拿到完整事件回放。

### 事件格式

每个 SSE `data:` 行是一个 JSON 对象。常规事件带序号信封：

```jsonc
{ "seq": 3, "at": 1690000000000, "event": { "type": "...", ... } }
```

| `event.type` | 说明 |
|---|---|
| `task_created` | 任务已创建（含 `taskId`、`state: "queued"`、`versions`） |
| `status` | 状态迁移（含新 `state`，终态时含 `stopReason`） |
| `agent_event` | Agent 事件转发（`agentEvent` 字段），与 WebUI 事件流同一线格式：`message_start` / `message_update`（含文本增量与工具调用增量）/ `message_end` / `tool_execution_update` / `extension_ui_request` 等 |
| `result` | **最后一个事件**。`result` 字段与 `GET /result` 响应体完全一致（finalResponse、usage、toolCallLog、artifacts…），另附 `versions` |

例外：重连时若服务端事件缓冲已截断，会先推一条无信封的通知 `{"type":"notice","notice":"event_buffer_truncated","firstSeq":22}`；任务不存在时推 `{"type":"error","error":"Task not found"}` 后关流。

### 语义要点

- **断线不取消任务**：SSE 流只是任务的视图。客户端断开后任务继续执行，可重连 `/stream`、轮询或取消。
- **`waiting_input` 可见**：Agent 弹出交互对话框时流中会先收到 `status`（`state: "waiting_input"`）与对应 `extension_ui_request` 事件；`inputTimeoutMs` 超时自动应答后回到 `running`。
- **心跳**：每 30 秒推送一个 SSE 注释帧（`:\n\n`），用于保活与代理缓冲探测。
- **缓冲上限**：每任务服务端保留最近 500 条事件用于重放；超出丢弃最旧并置截断标记。`result` 恒为最后一条，重连已结束任务总能拿到完整结果。
- 暂不支持按 `seq` 断点续传（V2 候选）。

### curl 示例

```bash
# 创建并流式观察
curl -N -X POST http://localhost:30141/api/batch/tasks \
  -H "Content-Type: application/json" \
  -H "X-Platform-API-Key: sk-your-admin-key" \
  -d '{
    "mode": "host",
    "workDir": "/data/batch-test/demo",
    "prompt": "Create a hello world Node.js project with a test file, then run the tests.",
    "stream": true,
    "timeoutMs": 120000
  }'

# 订阅一个已有任务的事件流（重放 + 实时）
curl -N http://localhost:30141/api/batch/tasks/$TASK_ID/stream \
  -H "X-Platform-API-Key: sk-your-admin-key"
```

---

### 取消任务

```
POST /api/batch/tasks/{taskId}/cancel
X-Platform-API-Key: sk-...
```

**响应（200 OK）：**

```json
{ "taskId": "a1b2c3d4-...", "state": "cancelled" }
```

幂等：取消已终止的任务返回当前状态而非报错。

---

### 列出任务

```
GET /api/batch/tasks?limit=20
X-Platform-API-Key: sk-...
```

**响应（200 OK）：**

```json
{
  "tasks": [
    { "taskId": "...", "state": "completed", "stopReason": "end_turn", ... },
    { "taskId": "...", "state": "running", ... }
  ]
}
```

---

## 交互任务自动应答机制

当 Agent 调用需要用户交互的工具时（`ask_user_question`、`exit_plan_mode`），任务进入 `waiting_input` 状态。在 `inputTimeoutMs`（默认 1 分钟）内无人应答即自动应答：

| 工具 | 自动应答行为 |
|---|---|
| `ask_user_question` | 选择第一个选项（推荐选项） |
| `exit_plan_mode` | 自动批准，选择"直接实施" |
| 其他 `confirm` 对话框 | 自动批准（`true`） |
| 其他 `input` 对话框 | 返回空字符串（模型自行判断） |

**注意**：自动应答不会取消任务——任务继续以自动应答的结果推进。这确保长时间测试不被阻塞。
（交互式会话侧，exit_plan_mode 确认框自 2026-09-29 起**无限等待用户**、不再 300s 自动过期——超时≠拒绝，对齐 ZCode/codex 的权限 ask 语义；批量场景由上表的 `inputTimeoutMs` 应答兜底。）

## 并发上限（1.4 起）

环境变量 `PI_WEB_BATCH_MAX_CONCURRENT`（默认未设=不限）。设置后超出上限的任务保持
`queued` 状态 FIFO 排队，运行中任务终态（含取消/超时）后自动补位；取消排队中的任务
会直接出队（`POST /tasks/{id}/cancel`）。每次任务真正开跑时才占用并发额度与超时预算。
建议：单事件循环部署按 LLM 配额与内存设置（VM 级 4-8，专用服务器按量）。

## 错误码

| HTTP 状态 | 含义 |
|---|---|
| 400 | 请求体格式错误 / 缺少必填字段 / sandbox 模式未配置或缺 `containerId` / sandbox 模式携带 `files` |
| 401 | API Key 无效或未提供 |
| 403 | 非管理员身份 |
| 404 | 任务不存在 / 产物路径不在清单 |
| 409 | 任务仍在运行（获取结果或产物时）；resume 非 `interrupted` 任务 |
| 410 | 产物文件已被清理（清单还在、文件没了） |
| 413 | 请求体过大 / 产物超过 2MB 上限 |
| 415 | Content-Type 不是 application/json |
| 502 | 平台 API 调用失败 |

## 使用示例（curl）

```bash
# 创建任务
TASK_ID=$(curl -s -X POST http://localhost:30141/api/batch/tasks \
  -H "Content-Type: application/json" \
  -H "X-Platform-API-Key: sk-your-admin-key" \
  -d '{
    "mode": "host",
    "workDir": "/data/batch-test/demo",
    "prompt": "Create a hello world Node.js project with a test file, then run the tests.",
    "files": {
      "package.json": "{\"name\":\"demo\",\"scripts\":{\"test\":\"node test.js\"}}"
    },
    "timeoutMs": 120000
  }' | jq -r '.taskId')

echo "Task created: $TASK_ID"

# 轮询状态
while true; do
  STATE=$(curl -s http://localhost:30141/api/batch/tasks/$TASK_ID \
    -H "X-Platform-API-Key: sk-your-admin-key" | jq -r '.state')
  echo "State: $STATE"
  [ "$STATE" = "completed" ] || [ "$STATE" = "failed" ] || [ "$STATE" = "cancelled" ] && break
  sleep 5
done

# 获取结果
curl -s http://localhost:30141/api/batch/tasks/$TASK_ID/result \
  -H "X-Platform-API-Key: sk-your-admin-key" | jq '.finalResponse'
```

## 限制与 TODO

- **SSH / Local-machine 模式**：暂不支持（需要 relay 配置，V2 计划）
- **交互式多轮测试**：当前仅支持一次性 prompt；多轮对话需 V2 的 follow-up 接口
- **SSE 断点续传**：重连从缓冲区头重放（客户端按 `seq` 去重），不支持 `Last-Event-ID` 式按序号续传（V2 候选）
- **任务持久化**：当前任务状态在 pi-web 内存中（globalThis），重启后运行中任务丢失；终态任务结果可通过 sessionFile 回溯
- **并发限制**：无内置限制（依赖系统资源自然约束）；生产环境建议外部队列控制并发数
- **沙盒自动创建**：sandbox 模式下如未指定 containerId，将自动创建容器（使用默认镜像）
