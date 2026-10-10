# 网关 session_id 收集 ↔ Agent 框架模型配置的依赖关系

> 2026-10-10 整理。背景：agentgateway（fork，dev 分支）的会话追踪按请求 header 提取
> session id；pi 侧是否发送这些 header **由模型配置（compat）决定，且默认关闭**。
> 本文记录完整依赖链与三种打通方式，供后续部署/排障/升级 pi 版本时查阅。
> 配套网关侧文档：agentgateway/design/platform-llm-key-integration.md。

## 一、两端的事实

### agentgateway 侧（怎么收）

- 提取规则是**可配置 CEL**：`config.standardAttributes.session`，
  默认值（crates/agentgateway/src/config.rs:25）：

  ```cel
  coalesce(request.headers["x-session-id"],
           request.headers["session_id"],
           request.headers["x-session-affinity"], null)
  ```

  即只看三个 header，**不看请求体**。提取结果落 `request_logs.agentgateway_session`
  索引列，供 `/llm/sessions` 页、会话聚合 API、日志按会话筛选使用
  （commit ba2f916d）。
- 同族的另两个标准属性：`agentgateway.user`（认证身份 CEL，见网关文档）与
  `agentgateway.group`。

### pi 侧（怎么发，@earendil-works/pi-ai 1.1.0 实测源码）

openai-completions 适配器（`pi-ai/dist/api/openai-completions.js`）：

1. **数据源**：`options.sessionId` ← Agent 的 `sessionId`（pi-coding-agent 会话的
   sessionId，即 pi-web 会话文件 id，自动携带，无需配置）。
2. **总开关（模型级 compat）**：`compat.sendSessionAffinityHeaders`——
   **默认仅 OpenRouter 端点为 true，其余 false**（types.d.ts:692）。false 时什么都不发。
3. **前置条件**：cacheRetention ≠ "none" 才把 sessionId 传入 header 构造
   （openai-completions.js:185）。默认 resolveCacheRetention → "short"（:142-150），
   满足；只有显式配了 none 或某些无缓存元数据模型的降级路径才可能为 none。
4. **格式（compat.sessionAffinityFormat，可自动探测）**：
   - `"openrouter"` → header `x-session-id`；
   - `"openai"` → headers `session_id` + `x-client-request-id` + `x-session-affinity`；
   - 未设 → `x-client-request-id` + `x-session-affinity`。
5. 另有 body 参数 `prompt_cache_key`（仅 api.openai.com 域名时发，与 session header
   互不影响）；以及模型级静态 `headers` 字段（合并在最后，可覆盖默认头，但静态值
   无法携带每会话 id，**不能**用于本目的）。

**结论：pi 对非 OpenRouter 的 OpenAI 兼容端点默认一个 session header 都不发。**
这就是"网关 session 列为空"的第一嫌疑（第二嫌疑是没配认证导致 user 列为空）。

## 二、三条打通方式（按推荐排序）

### 方式 A（推荐）：模型注册时开 compat

- **沙盒/SSH/本机会话**（平台下发模型的场景）：`pi-config/agent/extensions/amedac-core/src/sandbox/lib/llm.ts`
  的 `ensureLlmProvider` 在 `pi.registerProvider(...)` 的 models 数组每项加：

  ```ts
  compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" }
  ```

  （`ProviderChatModelConfig.compat` 存在，pi-coding-agent extensions/types.d.ts:1472；
  pi-ai 的 compat 字段见 types.d.ts:692-694。）"openai" 格式发出的
  `session_id`/`x-session-affinity` 都在网关 CEL 命中范围，双保险。
- **pi-web 自有 provider**（模型页/models.json 配置的）：models.json 的模型/条目
  compat 同样支持这两个字段（models-config 管理页写入；pi 0.87+ 的 compat 透传）。
- 特点：**零网关改动**；网关侧日志/会话页立即按 pi 会话 id 归因。

### 方式 B：扩展 body 注入（现状 litellm_session_id 的等价物）

扩展 `before_provider_request` 往请求体塞字段（现 amedac-core sandbox index.ts:92-112
对 litellm 的做法，经 pi-ai 的 `options.onPayload` 钩子生效）。网关默认 CEL 只看
header，但 **CEL 上下文里有 `request.body`**（cel/types.rs:927-968）——改
`config.standardAttributes.session` 配置（例如加 `request.body.session_id` 分支）即可
生效，**不需要改网关代码**。仅在方式 A 不可用（如目标网关只认 body 字段）时使用；
迁移后如果暂时保留 litellm 兼容期，注意两个字段名不要同时启用以免归因分裂。

### 方式 C：网关改 CEL 从别处取

例如统一取 `Authorization` key id + 请求序号自造 session——不推荐，丢失"同一 pi 会话
跨多次请求"的归因语义。

## 三、排障速查

| 症状 | 依次检查 |
|---|---|
| 网关 Sessions 页空 | ① pi 侧模型 compat 是否开了 sendSessionAffinityHeaders（方式 A）；② 直连抓包/网关日志确认 `x-session-affinity` 或 `session_id` header 在场；③ cacheRetention 是否被配成 none |
| Logs 页 user 筛选无值 | LLM 路由是否挂 `policies.apiKey`；key 是否带 `metadata["agentgateway.dev/owner"]`（管理 API 建的 key 自动盖） |
| 会话分裂（同一会话多条） | 换了 sessionAffinityFormat 或混用了 header 与 body 注入两路；统一成方式 A |
| Bedrock 后端下 session 丢失 | 网关对 Bedrock 上游会剥离 `conversation_id`/`session_id` header（仅防 AWS 签名失配，llm/mod.rs:1901-1905）——这是**发往上游**的方向，客户端→网关侧的 `x-session-affinity` 不受影响；若 CEL 命中的恰是 `session_id`，换 `x-session-affinity` 优先 |
| MLflow 里看不到 session | OTLP span 默认无 session 属性；用 `frontendPolicies.tracing.attributes`（CEL）附加，无需改码 |
| 升级 pi 后失联 | 复查 pi-ai changelog 中 compat 字段名（sendSessionAffinityHeaders/sessionAffinityFormat）与默认值是否变化；本文件行号对应 pi-ai 1.1.0 |

## 四、与既有机制的关系

- 该 header 同时服务**提示缓存亲和**（上游按会话粘路由可提高缓存命中），开 compat
  是双赢，不只是为了网关归因。
- pi-web 的 `agent_settled`/批量 API 的会话语义与网关 session 无直接耦合；网关 session
  只是同一 pi sessionId 在网关侧的镜像。
- MLflow/feedback 链路按 session_id 关联（网关 fork 自带），方式 A 生效后自动可用。
