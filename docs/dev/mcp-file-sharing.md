# Agent → MCP 服务的文件传递：现状评估与分享链接方案

> 2026-11-02。回答"能否把 /api/files、/api/remotefs 的读取链接直接发给
> MCP 服务端回拉"。结论先行：**不能直接用**（会话 Cookie 绑定）；推荐新增
> 一个带令牌的分享端点（模式 B），小文件可用参数内联（模式 A）兜底。

## 一、现状：两条路由都不能当"分享链接"用

| 维度 | /api/files/\<path\>?type=read|download | /api/remotefs/\<path\>?src=\<sid\>&type=read |
|---|---|---|
| 认证 | 会话 Cookie（`pi_web_sid`，HttpOnly + **SameSite=Lax**），经 `getAllowedFileRootsForRequest → requireUserIdentity` | 同样 Cookie，经 `resolveRemoteSession → requireUserIdentity` |
| 授权 | 路径必须落在"该用户的允许根"（会话 cwd 集合等） | `src` 会话必须归当前用户所有（跨用户 404） |
| 无 Cookie 访问 | 401（多用户模式） | 401 |
| 返回形态 | 媒体=原始字节（含 Range）；**文本 read=JSON `{content,…}`**；download=原始字节 | 同左（近期刚对齐） |
| 链接离开浏览器 | 立即失效（Cookie 不随行） | 同左，且容器/agent 离线后 502 |

三个叠加的原因：

1. **MCP 服务端进程没有 Cookie**。它是服务端到服务端的 HTTP 客户端，不会带
   浏览器会话；`requireUserIdentity` 直接 401。
2. **SameSite=Lax** 即便在浏览器侧也会挡第三方站点的子资源请求——HTML 预览
   iframe 图片 403 就是同一机制（我们已用"第一方内联 data: URL"绕过）。
3. **授权与"当前用户"强绑定**：`src=<sessionId>` 还要做会话归属校验，链接
   里连"匿名只读"的概念都没有。

唯一例外：`PI_WEB_AUTH=off` 的单用户部署里 `requireUserIdentity` 返回隐式
host 身份，链接无需 Cookie 即可访问——但多用户教学模式不适用。

另：即使解决了认证，`type=read` 对**文本**文件返回的是 JSON 包裹
（`{content, language, size}`），外部消费方应使用 `type=download` 拿原始字节。

## 二、两种传递模式对比

**模式 A：直接把文件数据发给 MCP（工具参数内联）**

- pi 里 MCP 工具调用由**模型构造参数**：文件内容要作为参数值经模型输出
  （通常 base64）。上下文成本 ≈ 1.4×文件大小，还受 MCP 参数长度限制。
- 小文件可行（几 KB 的配置/小图），大文件不可行。HTML 预览的资源内联实践
  里 8MB/项、24MB/文档的上限已经算激进。
- 优点：无新增基础设施、离线可用、MCP 服务端零改动（只要它接受内容参数）。

**模式 B：把 WebUI 生成的链接发给 MCP，由服务端回拉**

- 零上下文成本、大小无关、可撤销可审计；前提是 MCP 服务能访问 WebUI
  （内网部署天然满足）。这也是大厂 MCP 文件上传/下载闭环的通行做法。
- 需要新增"分享令牌"端点——**不能**在现有两条路由上加 `?token=` 修补：
  那会把"会话身份"与"单文件能力"混在一个入口上，审计与撤销都做不干净。

**结论：B 为主，A 为小文件兜底。**

## 三、方案：`/api/share/<token>`（单文件、限时、限次）

### 3.1 接口

```
POST /api/share                     （登录态 + isApiRequestAllowed）
  { path: "/abs/path" , srcSession?: "<sid>", ttlMinutes?: 30,
    maxDownloads?: 10, oneTime?: false }
→ { url: "http://<host>/api/share/<token>", expiresAt, downloads: 0 }

GET  /api/share/<token>             （无 Cookie —— token 即凭证）
→ 原始字节 + Content-Type/Length（复用 /api/files 的 streamFile 与
  remotefs 的 remoteReadBinary；文本走 download 语义）
  失败：410 过期 / 404 不存在 / 429 超次数 / 502 远端离线

DELETE /api/share/<token>           （创建者或管理员；提前撤销）
```

`srcSession` 缺省 = Host 文件（/api/files 语义）；带上 = 远程会话文件
（/api/remotefs 语义）。**一个 token 只绑定一个文件**，不继承用户身份、
不能列目录。

### 3.2 安全要求（硬性）

1. **token**：`randomBytes(16)` → base64url（128 bit），枚举不可行；服务端
   可只存 sha256(token)。
2. **最小权限**：token→(path[, srcSession]) 单向绑定；读取不落任何用户态。
3. **期限 + 次数双限**：默认 30 分钟 / 10 次；过期即删。提供 oneTime。
4. **审计**：管理员可见"谁在何时分享了哪个文件、被拉取几次、来源 IP"
   （沿用 operation_logs 思路）。
5. **响应头**：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`
   （防止 token 经 Referer 泄给第三方）；GET 无副作用 ⇒ 无 CSRF 面。
6. **限额**：单文件大小上限（建议 100MB，媒体预览的 10MB 上限不适用于此）、
   创建频率限流（复用 rate-limit 基建）。
7. **URL 进日志的自觉**：MCP 服务端/代理日志会留下完整 URL；靠短 TTL 与
   可撤销兜底，文档明示。
8. **远程文件的生命周期**：token 存活期 ≠ 容器存活期；容器销毁后读取 502，
   响应里提示"远端已离线"。

### 3.3 明确不做

- **不给 MCP 服务用户级平台 key**（sk_ 是全权钥匙，越权面太大）。
- 不在 /api/files、/api/remotefs 上加 `?token=` 参数（见上）。
- 不做目录级分享（首期）；需要时再评估打包下载。

### 3.4 Agent 会话内调用面：`share_file` 工具

`POST /api/share` 是浏览器会话接口（Cookie + CSRF 守卫），**Agent 不能直接
curl 它**——bash 工具跑在服务器/容器/用户机器上，没有 `pi_web_sid`。会话内
的正确入口是内联扩展注册的工具（与 bg_run / plan_save 同模式，进程内直调
share-store，不走 HTTP）：

```
模型调用: share_file({ path: "report.pdf" })
   ↓ inline extension（lib/extensions/share.ts，进程内）
返回: { url, expiresAt } → 模型把 url 作为 MCP 工具的 file_url 参数
   ↓
MCP 服务端 GET /api/share/<token>（无 Cookie）
```

四种模式统一（工具经 ctx.sessionManager.getSessionId() 拿到 srcSession，
路径栅栏复用各模式的会话工作区语义）：

| 模式 | share 绑定 | GET 取数路径 |
|---|---|---|
| host | 服务器路径（会话 cwd 栅栏） | 本地 fs 直读 |
| sandbox | (srcSession, path) | 容器在线时经平台 tools/read 代理 |
| local-machine | (srcSession, path) | agent 在线时经 relay 代理 |
| ssh | (srcSession, path) | SSH 在线时经 sftp 代理 |

审计记录 ownerId + sessionId；限流按会话计。`POST /api/share` 保留给 WebUI
（文件面板"生成分享链接"），与工具共用同一个 store。

### 3.5 落点与工作量预估

| 项 | 位置 | 量级 |
|---|---|---|
| 存储（内存 + dataDir 持久化） | `lib/share-store.ts` | ~100 行 |
| 三条路由 | `app/api/share/…` | ~150 行 |
| 字节读取复用 | 抽 /api/files 的 streamFile 与 remotefs 分支为共享 helper | ~80 行重构 |
| `share_file` 内联扩展（Agent 调用面） | `lib/extensions/share.ts` | ~80 行 |
| Agent 侧引导 | agent-packaging 技能/mcp.json 说明：传文件优先 `file_url` 参数，勿塞 base64 | 文档 |
| 测试 | token 生命周期/限额/审计/远程离线/工具四模式 | ~150 行 |

## 四、过渡方案（今天就能用，但不推荐长期）

把文件上传到平台"我的工作区"，让**自建的** MCP 服务用平台工作区 API
（X-API-Key + `/api/v1/workspaces/:id/files/content`）拉取。内网可控时可行，
但那是用户级全权 key，只适合完全可信的自建服务；对第三方 MCP 服务绝不能
这么发。
