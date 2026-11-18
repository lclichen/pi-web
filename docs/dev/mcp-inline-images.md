# MCP 内联图片：约定与落地（0.0.4-alpha+）

目标：MCP 返回的图片既能在最终回答里按原位置显示，又能在 Agent 重写后保留；图片长期有效，不依赖 MCP 服务的 URL/TTL。

## 1. MCP 服务端约定

图片使用标准 `ImageContent`，不要只把 base64 塞进 `TextContent`：

```json
{
  "content": [
    {
      "type": "text",
      "text": "页面渲染结果如下：\n\n[[image:homepage|首页截图]]\n\n可以看到顶部导航..."
    },
    {
      "type": "image",
      "data": "iVBORw0KG...",
      "mimeType": "image/png",
      "annotations": { "audience": ["user"], "priority": 0.8 },
      "_meta": { "amedac/imageId": "homepage", "amedac/alt": "首页截图" }
    }
  ]
}
```

规则：

- `data` 是纯 base64，不是 `data:` URI；`mimeType` 必填；
- 文本里的 `[[image:<serverId>|alt]]` 表示图片在文本中的精确位置；
- `_meta["amedac/imageId"]` 与文本占位符对应；`_meta["amedac/alt"]` 是默认 alt；
- 大图请压缩（建议 PNG/WebP、单张尽量 ≤ 5 MB）；不要用 `structuredContent` 放 base64；
- 兼容旧格式：Markdown data URI、裸 data URI、`<img src="data:...">` 会被适配器解析并替换为短标记。

## 2. 处理链路

```text
MCP content
  └─ pi-mcp-adapter: 解析 image / 资源 blob / 旧式 data URI
       计算 img_<sha256(base64)[0..16]> 作为稳定 id
       文本标记替换为 [[image:img_...|alt]]
       details.mcpImages = [{ id, mimeType, bytes, alt }]
  └─ pi-web: 工具结果到达时同步写入
       <dataDir>/session-images/<sessionId>/<id>.<ext>
       （无 TTL，随 data/ 备份；会话删除时清理）
       发给浏览器的事件把 image block 改成
       { type:"image", source:{ type:"url", url:"/api/sessions/<sid>/images/<id>" } }
  └─ Agent: 最终回答只保留短标记
  └─ MarkdownBody: 把 [[image:img_...|alt]] 渲染成
       ![alt](/api/sessions/<sid>/images/<id>)
```

模型上下文仍然保留原始 image block（视觉模型可见）；浏览器只收到 URL，不再重复传输 base64。非视觉模型由 pi-ai 替换成 `(see attached image)`。

## 3. 存储与端点

- `lib/session-images.ts`：内容寻址、原子写、按会话分目录；
- `GET /api/sessions/[id]/images/[imageId]`：会话归属校验 + embed token、MIME 白名单、流式返回；
- 没有 10 MiB 的业务上限：文件/端点按原图存储和返回；
- 内联 base64 的解析有独立的安全上限（默认 64 MiB），超过时替换成短省略提示，避免把几百 MB base64 灌进模型上下文。

## 4. 前端与导出

- `components/MarkdownBody.tsx` 支持 `imageSessionId`，在 Markdown 渲染前解析标记，跳过代码围栏和行内代码；
- 工具结果卡片会去掉标记文本，图片走现有结果图片区；
- `/api/sessions/[id]/export` 把标记替换成 data URL，导出 HTML 自包含；
- `/api/...` URL 不会被 `resolveLocalFileHref` 当本地文件（`lib/file-links.ts` 对 `/api/` 返回 null），不会拼成 `/api/files/...`。

## 5. 当前边界

- `annotations.audience` 暂未用于控制“模型是否可见”，所有图片仍进入 model content（Phase 2 再做按需查看/省 token）；
- `resource_link` 图片仍以链接文本返回，不自动下载；
- 旧会话（没有 session-images 资产）里的标记无法解析，会显示占位文本；新会话从工具结果到达时开始持久化；
- MCP 服务返回 URL 而不是 base64 时，需要服务端/适配器在工具调用时立即下载并落盘，不能依赖 URL 长期有效。
