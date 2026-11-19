# OTLP 链路追踪（MLflow / GenAI semconv）

pi-web 的 Agent 会话通过 amedac-core 内置的零依赖 OTLP/HTTP JSON 上报器发送
trace 到自部署 MLflow（默认 `http://localhost:8087`，兼容 MLflow 3.15）。

## 配置（全局配置页）

`设置 → 全局配置 → 链路追踪（OTLP）`：

- **启用 OTLP 链路追踪**：总开关，默认关。
- **地址**：基础 URL。保存时只保留 origin+path，发送时自动追加
  `/v1/traces`（也接受直接填完整 `/v1/traces`）。
- **请求头**：键值对。MLflow 必须配置：

  ```
  x-mlflow-experiment-id = <实验 ID>
  ```

  其他需要鉴权的收集器可以加 `Authorization` 等；只保存名称和值都非空的项。

设置落在 `<dataDir>/server-settings.json` 的 `otelEnabled/otelEndpoint/
otelHeaders`，每次新提示词读取一次，管理员改了设置不需要重启（新会话/下一次
prompt 生效）。

## 生成的 trace 结构

每个用户提示词一棵 trace；同一会话的多轮提示词共享 session id，在 MLflow 的
Sessions 视图中归为一组：

```
invoke_agent amedac-pi-web       (AGENT)
├─ turn                         (内部)
├─ chat <model>                 (CHAT_MODEL)
└─ execute_tool <tool>           (TOOL)
```

主要属性（GenAI semconv；MLflow 用它推断 span 类型）：

| 属性 | 值 |
|---|---|
| `gen_ai.operation.name` | `invoke_agent` / `chat` / `execute_tool` |
| `session.id` / `gen_ai.conversation.id` | pi-web 会话 id（子智能体为子会话 id） |
| `gen_ai.agent.name` | 主会话 `amedac-pi-web`；子智能体取 `<active_agent>` 名 |
| `user.id` / `user.name` | 登录用户（pi-web 身份注册表；CLI 无此属性） |
| `gen_ai.input.messages` | `[{role:"user",parts:[{type:"text",content:...}]}]` |
| `gen_ai.output.messages` | assistant 文本 + tool_call parts；**根 span 也复制最终输出**，MLflow 的 Response 列与 `trace_info.response_preview` 取根 span outputs |
| `gen_ai.provider.name` / `request.model` / `response.model` | 模型与 provider（根 span 也带最终模型） |
| `gen_ai.usage.*_tokens` | input/output/cache read/cache creation/reasoning |
| `gen_ai.response.finish_reasons` | stop/error/aborted 等 |
| `gen_ai.tool.name` / `call.id` / `call.arguments` / `call.result` | 工具调用 |

根 span 还带 `pi.user_prompt`、`pi.session.kind`（main/subagent）。子智能体会话
的父会话 id 用于查用户身份，`gen_ai.conversation.id` 仍是子会话自己的 id。

## 代码位置

- `pi-config/agent/extensions/amedac-core/src/otel-tracing.ts`：配置解析、
  OTLP/HTTP JSON 编码、span 树、扩展注册。仅使用 Node 内置模块，**零 OTel SDK
  依赖**，离线包无需 npm install。
- `amedac-core/index.ts`：随核心扩展默认注册；pi-web 与 CLI 共用同一份源码。
- `lib/extensions/otel-tracing.ts`：pi-web re-export shim（测试/调试用）。

## 验证

- `lib/extensions/otel-tracing.test.mjs`：本地 HTTP stub 接收真实
  `/v1/traces` 请求，断言 span 树、`session.id`、user 属性、MLflow 请求头、
  prompt/输出/tool args+result，以及同一会话两次提示词生成两棵 trace 且
  根 span 输出正确。
- `lib/server-settings.test.mjs`：endpoint/header 校验与持久化。
- 已用 MLflow 3.15.0 实机验证：两轮对话生成两棵 trace，均带
  `mlflow.trace.session`，`response_preview` 分别为两轮的 assistant 输出；
  `mlflow.search_sessions()` 将两棵 trace 归入同一会话。

MLflow 侧只需启动 tracking server 并开放 OTLP：

```bash
mlflow server --host 0.0.0.0 --port 8087
```

首次使用时在 MLflow 中创建实验，把实验 ID 填到 `x-mlflow-experiment-id`。
追踪内容包含提示词、assistant 输出和工具参数/结果；请只指向可信的收集器。
