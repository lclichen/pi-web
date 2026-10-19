# SkillHub API 接口整理（搜索 / 下载 / 版本）

> 来源：对 `http://172.18.34.89:39088/skillhub` 的实测（2026-10-19），含前端 bundle 路由提取 + 逐端点 curl 验证。

## 基础信息

- **Base URL**：`http://172.18.34.89:39088/skillhub`
- **两套 API 前缀**（路由完全同构，只是面向的客户端不同）：
  - `/api/v1/...` — CLI / Agent 用的 API
  - `/api/web/...` — Web 前端用的 API
- **前端页面**：`/skillhub/space/{namespace}/{slug}`（如 `/skillhub/space/global/pi-extension-dev1`）是 SPA 页面，数据来自 `/api/web/skills/{ns}/{slug}` 系列接口，直接 GET 只返回 HTML 壳，不含数据。

### 统一响应包络

详情 / 版本类接口（v1 与 web 相同）：

```json
{ "code": 0, "msg": "Fetched successfully", "data": { ... }, "timestamp": "...", "requestId": "..." }
```

错误时 HTTP 状态码与 `code` 一致，常见：

| HTTP | code | msg 示例 |
|------|------|----------|
| 400 | 400 | `Skill not found: xxx` / `Version not found: xxx` / `Namespace not found: xxx` |
| 401 | 401 | `Authentication required` |

注意：不存在的资源返回的是 **400** 而不是 404。

**例外**：skill 列表接口（搜索）的响应**没有包络**，直接是列表结构（见下）。

---

## 1. 搜索 / 列表

### GET `/api/v1/skills`（等价：`/api/web/skills`）

| 参数 | 说明 |
|------|------|
| `q` | 搜索词，匹配 slug / displayName / summary；支持多词空格分隔；前端把 `@ns 词` 拆成 `namespace=ns&q=词` 发送 |
| `namespace` | 限定命名空间（如 `global`），不带 `@` 前缀 |
| `label` | 按标签过滤 |
| `sort` | 取值实测均有效：`relevance`（默认）、`newest`、`downloads`、`stars`、`rating`、`updated`、`name` |
| `page` | 页码，**从 0 开始** |
| `size` | 每页条数，web 默认 20 |

**v1 列表响应**（无包络，游标分页）：

```json
{
  "items": [
    {
      "slug": "flowflow",
      "displayName": "flowflow",
      "summary": "...",
      "tags": {},
      "stats": { "downloads": 3, "stars": 0 },
      "createdAt": 0,
      "updatedAt": 1788450482702,
      "latestVersion": {
        "version": "20260811.080411",
        "createdAt": 1788450482702,
        "changelog": "",
        "license": null
      }
    }
  ],
  "nextCursor": null
}
```

`nextCursor` 在还有下一页时给出不透明游标（当前实例 skill 总数少，未触发）。

**web 列表响应**（有包络，offset 分页）：

```json
{ "code": 0, "msg": "...", "data": {
    "items": [ { "id": 3, "slug": "flowflow", "namespace": "global",
                 "displayName": "...", "summary": "...",
                 "visibility": "PUBLIC", "status": "ACTIVE",
                 "downloadCount": 3, "starCount": 0,
                 "ratingAvg": 0.0, "ratingCount": 0,
                 "updatedAt": "2026-08-11T08:13:58Z",
                 "headlineVersion":  { "id": 3, "version": "20260811.080411", "status": "PUBLISHED" },
                 "publishedVersion": { "id": 3, "version": "20260811.080411", "status": "PUBLISHED" },
                 "ownerPreviewVersion": null, "resolutionMode": "PUBLISHED",
                 "canSubmitPromotion": false } ],
    "total": 6, "page": 0, "size": 20
  }, "timestamp": "...", "requestId": "..." }
```

不传任何参数即返回全量（默认分页）。

---

## 2. Skill 详情

### GET `/api/v1/skills/{namespace}/{slug}`（等价：`/api/web/skills/{namespace}/{slug}`）

**namespace 必填**：只传 slug（`/skills/flowflow`）会把 slug 当成 namespace，报 `400 Namespace not found`。

`data` 字段（v1 / web 相同）：

```
id, slug, displayName, ownerId, ownerDisplayName, summary,
visibility (PUBLIC|...), status (ACTIVE|...),
downloadCount, starCount, subscriptionCount, ratingAvg, ratingCount,
hidden, namespace, labels [],
canManageLifecycle, canSubmitPromotion, canInteract, canReport,
headlineVersion {id, version, status},
publishedVersion {id, version, status},
ownerPreviewVersion, ownerPreviewReviewComment,
resolutionMode
```

附带的 `?version=` 参数经实测**不改变响应内容**（只校验），版本信息请用版本接口。

---

## 3. 版本

版本号格式：`YYYYMMDD.HHMMSS`（如 `20260811.080411`）。

### GET `.../skills/{namespace}/{slug}/versions` — 版本列表

支持 `page` / `size`（默认 size 20）。`data`：

```json
{
  "items": [
    { "id": 3, "version": "20260811.080411", "status": "PUBLISHED",
      "changelog": null, "fileCount": 1, "totalSize": 4499,
      "publishedAt": "2026-08-11T08:13:58Z", "downloadAvailable": true }
  ],
  "total": 1, "page": 0, "size": 20
}
```

### GET `.../skills/{namespace}/{slug}/versions/{version}` — 版本详情

在列表项字段之外，多两个关键字段（**这是不下载包就能拿到内容和文件清单的接口**）：

- `parsedMetadataJson` — JSON 字符串，含 SKILL.md 的完整 markdown `body`、`name`、`version`、`description`、`frontmatter`
- `manifestJson` — JSON 字符串，文件清单：`[{"path": "SKILL.md", "size": 4499, "contentType": "text/markdown"}]`

---

## 4. 下载

两种写法等价，都返回 **zip**：

```
GET /api/v1/skills/{namespace}/{slug}/download                    # 最新已发布版本
GET /api/v1/skills/{namespace}/{slug}/download?version={version}  # 指定版本
GET /api/v1/skills/{namespace}/{slug}/versions/{version}/download # 指定版本（路径式）
```

响应头（实测）：

```
HTTP/1.1 200
Content-Type: application/zip
Content-Length: 2278
Content-Disposition: attachment; filename="flowflow-20260811.080411.zip"
X-Request-Id: <uuid>
```

- 文件名约定：`{slug}-{version}.zip`，zip 内即 skill 文件（如 `SKILL.md`）。
- 仅支持 **GET**（HEAD 请求返回 401，只处理了 GET）。
- 无 ETag / checksum 头；需要校验可对比版本详情的 `totalSize`（解压后文件总大小）或自行 sha256。
- 不存在的版本：`400 Version not found: {version}`。

### 一键下载示例

```bash
curl -OJ 'http://172.18.34.89:39088/skillhub/api/v1/skills/global/flowflow/download'
# → 得到 flowflow-20260811.080411.zip
```

---

## 5. 认证

| 场景 | 要求 |
|------|------|
| 搜索、详情、版本、下载（**PUBLIC** skill） | 免认证，直接可用（实测均 200） |
| 私有（PRIVATE）skill 的详情/下载 | 需登录，否则 401 / 提示 login required |
| `/api/v1/namespaces` 等管理/账户接口 | 需认证（401） |

认证方式（来自前端 bundle）：

- **Web**：cookie session + `X-XSRF-TOKEN` 头，登录接口 `POST /api/v1/auth/local/login` 等。
- **CLI**：Device Authorization 流程（8 位用户码 `XXXX-XXXX`，浏览器完成授权后 CLI 换 token）。
- **API Token**：`/api/v1/tokens` 创建（明文只在创建时可复制一次），后续 v1 接口携带 token 调用。

---

## 6. 速查表（搜索 / 下载 / 版本核心 6 个接口）

| 用途 | 方法 + 路径 | 关键返回 |
|------|------------|----------|
| 搜索 | `GET /api/v1/skills?q=&namespace=&label=&sort=&page=&size=` | `{items[], nextCursor}`（v1）/ `data{items[],total,page,size}`（web） |
| 详情 | `GET /api/v1/skills/{ns}/{slug}` | 包络 `data`：owner、统计、`publishedVersion` 等 |
| 版本列表 | `GET /api/v1/skills/{ns}/{slug}/versions` | `data{items[{version,status,changelog,fileCount,totalSize,publishedAt,downloadAvailable}],total,page,size}` |
| 版本详情 | `GET /api/v1/skills/{ns}/{slug}/versions/{v}` | + `parsedMetadataJson`（文档全文）、`manifestJson`（文件清单） |
| 下载（最新） | `GET /api/v1/skills/{ns}/{slug}/download` | `application/zip`，`{slug}-{version}.zip` |
| 下载（指定） | `GET /api/v1/skills/{ns}/{slug}/versions/{v}/download` | 同上 |

> 以上路径把 `/api/v1` 换成 `/api/web` 即为 Web 前端等价接口（列表分页结构不同，见第 1 节）。
