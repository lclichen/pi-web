# pi-web 批量测试 API

> 版本 1.0 · 2026-09-20 · 认证方式：X-Platform-API-Key

## 概述

pi-web 批量测试 API 允许通过 HTTP 请求自动化执行 Agent 测试任务。每个任务在独立的工作目录中运行，支持 Host 模式（服务器目录）和沙盒模式（容器）。任务异步执行——提交后立即返回任务 ID，通过轮询获取状态，终态后获取完整结果。

**设计参考**：ACP (Agent Client Protocol) v2 的提交/完成分离模式——"提交成功 ≠ 任务完成"；StopReason 结构化枚举；`requires_action` 超时后自动应答（非取消）。

## 认证

所有请求需要管理员身份。两种方式：

### 方式一：平台 API Key（推荐，适合程序化调用）

```
X-Platform-API-Key: sk-xxxxxxxxxxxxxxxx
```

管理员在 pi-web 管理面板 → 用户 → 选择目标用户 → 创建 API Key（或用平台的 `/api/v1/auth/api-keys` 接口铸造）。

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

  // 必填：工作目录（服务器上的绝对路径或相对 pi-web 的路径）
  // 不存在则自动创建 + 自动信任
  // 已存在则自动加后缀（-2, -3, ...）确保干净环境
  "workDir": "/data/tests/my-project",

  // 必填：初始提示词（一次性请求，无交互）
  "prompt": "Read the test files in tests/ and fix any bugs you find. Run the test suite to verify.",

  // 可选：内联小文件（{相对路径: 内容}），写入 workDir
  "files": {
    "README.md": "# Test Project",
    "src/main.ts": "export function main() { return 42; }"
  },

  // 可选：文件包来源（二选一）
  // "path" = 服务器上已有目录/文件的路径（如公共 fixture 目录）
  "filePackagePath": "/shared/fixtures/test-project-v1",

  // 可选：指定模型（不指定则用会话默认）
  "model": { "provider": "zai", "modelId": "glm-4.7" },

  // 可选：总超时毫秒数（默认 600000 = 10分钟，范围 30s ~ 1h）
  "timeoutMs": 600000,

  // 可选：交互等待超时毫秒数（默认 300000 = 5分钟）
  // 超时后自动应答：ask_user_question → 选推荐选项；exit_plan_mode → 自动批准
  "inputTimeoutMs": 300000,

  // 可选：测试结束后是否停止沙盒容器（默认 true；仅 sandbox 模式）
  "stopContainer": true,

  // 可选：使用已有容器 ID（不指定则 sandbox 模式自动创建新容器）
  "containerId": 42,

  // 可选：关联的项目 ID（sandbox 模式下用于容器绑定）
  "projectId": 7
}
```

**响应（202 Accepted）：**

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
  "error": null                   // failed 时的错误信息
}
```

**状态说明：**

| 状态 | 含义 |
|---|---|
| `queued` | 任务已创建，尚未开始执行 |
| `running` | Agent 正在执行 |
| `waiting_input` | Agent 在等待用户交互（ask_user_question / exit_plan_mode 确认），超时后自动应答 |
| `completed` | 正常完成 |
| `failed` | 执行出错 |
| `cancelled` | 被取消（手动取消或超时） |

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
  "error": null
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

当 Agent 调用需要用户交互的工具时（`ask_user_question`、`exit_plan_mode`），任务进入 `waiting_input` 状态。在 `inputTimeoutMs`（默认 5 分钟）内无人应答：

| 工具 | 自动应答行为 |
|---|---|
| `ask_user_question` | 选择第一个选项（推荐选项） |
| `exit_plan_mode` | 自动批准，选择"直接实施" |
| 其他 `confirm` 对话框 | 自动批准（`true`） |
| 其他 `input` 对话框 | 返回空字符串（模型自行判断） |

**注意**：自动应答不会取消任务——任务继续以自动应答的结果推进。这确保长时间测试不被阻塞。

## 错误码

| HTTP 状态 | 含义 |
|---|---|
| 400 | 请求体格式错误 / 缺少必填字段 |
| 401 | API Key 无效或未提供 |
| 403 | 非管理员身份 |
| 404 | 任务不存在 |
| 409 | 获取结果时任务仍在运行 |
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
- **任务持久化**：当前任务状态在 pi-web 内存中（globalThis），重启后运行中任务丢失；终态任务结果可通过 sessionFile 回溯
- **并发限制**：无内置限制（依赖系统资源自然约束）；生产环境建议外部队列控制并发数
- **沙盒自动创建**：sandbox 模式下如未指定 containerId，将自动创建容器（使用默认镜像）
