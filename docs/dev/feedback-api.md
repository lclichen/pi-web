# 消息反馈链路（👍/👎 → pi-web 代理 → AI Gateway）

状态：**全链路已打通**（2026-09）。网关侧 `POST /api/feedback` 已实现并运行；
pi-web 侧代理 `app/api/feedback/route.ts` 注入用户身份后转发。
前端组件：`components/MessageFeedback.tsx`（复制按钮右侧的点赞/点踩）；
客户端库：`lib/message-feedback.ts`（本地持久化 + 发件箱重投，挂载时也会尝试清空发件箱）。

## 链路与信任边界

```
浏览器 ──POST /api/feedback（同源 Cookie）──▶ pi-web Next 服务
                                            │ requireUserIdentity 校验登录
                                            │ 丢弃客户端 user 字段，重打为会话登录名
                                            ▼
                              agentgateway POST /api/feedback（AGENTGATEWAY_URL）
                                            │ 落库 message_feedback（session_id+entry_id 主键，幂等 upsert）
                                            │ 对账回填 log_id/model（同会话 createdAt 之前最近一次调用）
                                            ▼
                                    { accepted: ["<sessionId>:<entryId>"] }
```

网关**只信任代理断言的 `user`**——浏览器绝不直连网关，客户端伪造的 `user` 字段在
pi-web 代理层被丢弃重写。

## pi-web 代理端点（app/api/feedback/route.ts）

- `POST /api/feedback`：任意登录用户。形状校验（feedback 非空数组、≤50/批）在代理层
  先挡一道，然后转发网关；网关应答原样透传（含 4xx 错误文本）。
- `GET /api/feedback`：**仅管理员**。流式透传网关的全量 JSONL 导出
  （`GET {AGENTGATEWAY_URL}/api/feedback/export`）。
- 环境变量：`AGENTGATEWAY_URL`（如 `http://127.0.0.1:4001`）。未配置时 POST 返回
  `503 {accepted:[]}`、GET 返回 503——客户端发件箱原样保留，配置后自动补投。
- 网关不可达/网关 5xx → POST `502 {accepted:[]}`（发件箱重试；网关 5xx 响应体不透传，
  避免向普通用户泄漏内部细节）；GET → `502 {error:…}`。

## 客户端行为（lib/message-feedback.ts，未变）

- 每条 assistant 消息（流式结束后）在复制按钮右侧出现 👍 / 👎 按钮（行悬停时显示）。
- 点击置为该评价；再次点击同一按钮取消评价；点击另一个按钮切换评价。
- 评价立即写入 localStorage（`pi-web:message-feedback`），键 `<sessionId>:<entryId>`；
  取消评价只清本地，不向网关发删除。
- 投递：每次新评价或组件挂载时尝试清发件箱；非 2xx 或未进 `accepted` 的条目留在
  发件箱下次重试。发件箱上限 500 条，先进先出。

## 网关侧已实现语义（agentgateway 仓库）

- 批量上限 50（超出 400）；同键重复投递按最新 value 幂等覆盖。
- 校验：空/超长(>512) sessionId/entryId、非法 createdAt → 400；snippet 截断 2000 字符。
- 对账回填：写入时按同会话 `createdAt` 之前最近一次调用回填 `log_id` 与 `model`；
  对不上的会话正常入库、对齐字段留空。
- 入参宽容：未知字段不报错（pi-web 以后加字段不打断上报）。
- 导出：`GET /api/feedback/export` 全量 JSONL（另有 `POST /api/logs/export` 请求日志导出）。

## 部署提醒

1. `AGENTGATEWAY_URL` 指向网关的 **UI/管理端口**（`/api/feedback` 已在 UI 路径白名单
   `ui_matches()` 中）。网关未部署的环境（如当前 VM）不配置该变量即可——功能静默
   降级为纯本地评价。
2. 网关 `username` 由代理断言：**把网关 UI 端口暴露公网前必须挂认证**（OIDC/basicAuth），
   否则 `/api/feedback/export` 连同全部请求日志都可达。
3. `/api/*` 是网关 UI 端口的保留前缀——后端服务自己叫 `/api/feedback` 会被 UI 后端拦截。

## 已知限制（有意为之）

- 纯客户端持久化 → 换浏览器/清缓存丢历史**本地标记**（网关侧记录不受影响）。
- snippet 只有前 200 字符且不加密 → 网关侧务必当作非敏感预览处理。
- 不采集用户消息的评价（用户可编辑/撤回，语义不稳定）。
- 取消评价不上报网关——网关侧保留最后一次非取消评价；显式撤回需要网关提供
  `DELETE /api/feedback?sessionId=…&entryId=…`，客户端后续接入。
- 发件箱无重试上限：一条永久 4xx 的坏条目（如超长 sessionId）会一直留在队首，阻塞
  其后合法条目的投递（客户端遇到非 2xx 即停止本轮）。需要时可在客户端加"跳过
  连续失败条目"的退避策略。
