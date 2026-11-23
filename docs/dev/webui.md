# WebUI 架构与前端约定

> 状态：现行（2026-11-23）。本文覆盖 pi-web WebUI 本体（Next.js app/components/hooks）
> 的结构与约定；后端会话/工具层见 [PLATFORM.md](./PLATFORM.md)。

## 1. 技术栈

- Next.js 16 App Router，React 19，TypeScript。
- 开发用 Turbopack；不要在 dev 服务运行时对同一 `.next` 执行 `next build`。
- 样式：CSS 变量 + inline style；规则见仓库根 `DESIGN.md`。
- 客户端状态：URL 参数 + hooks + 服务端 API；不引入全局状态库。
- 三语：en / zh-CN / zh-TW，英文 dot-key，三文件同键集。

## 2. 目录

```
app/                路由 + API（App Router）
  api/              BFF/服务端路由
  login/            登录页
  embed/            嵌入会话页
components/         UI 组件（Sidebar/ChatWindow/FileViewer/Settings/...）
hooks/              客户端状态与 SSE/轮询
lib/                服务端逻辑（session/rpc/relay/mcp/config/state）
public/             PWA、monaco、图标
```

## 3. 页面骨架

- `AppShell`：三栏（侧栏/会话/右侧面板）+ 底部终端抽屉；URL 驱动选中项目/会话/文件。
- `SessionSidebar`：项目树、Host(CLI) 空间、Quick、置顶/未读、文件面板入口、设置入口。
- `ChatWindow`：消息流、工具卡、审批、队列、Plan、子智能体面板。
- `TabBar/FileViewer`：会话与文件标签，Markdown/代码/媒体/PDF/DOCX 预览。
- Settings：通用/模型/技能/Agents/MCP/插件/API 密钥/全局配置（管理员）。
- Admin：用户/容器/镜像/workspace/配额/日志/LLM 绑定。

移动端：抽屉化布局 + 底部工具条；核心操作不能只在桌面可达。

## 4. 请求与实时

| 方向 | 机制 |
|---|---|
| 读取列表/详情 | REST `/api/*`，服务端缓存/围栏 |
| 会话事件 | SSE `/api/agent/[id]/events` |
| Agent relay 状态 | SSE `/api/agent-relay/status/events`（30s 心跳） |
| 终端 | SSE `/api/terminal/[sid]/events` 或平台 PTY 代理 |
| 批量任务 | SSE `/api/batch/tasks/[id]/stream` |
| 轮询 | 只有轻量 `/api/agent/running`；会话列表不逐秒强刷 |

原则：

- 浏览器不直连平台 API、Agent、SSH；全部经 pi-web BFF。
- SSE 断线重连用 Last-Event-ID/重放；组件卸载要 abort。
- 文件/终端面板按会话 descriptor 选择 host/remotefs/ssh/sandbox 数据源。
- 所有 fetch `res.json()` 需要空体兜底；客户端 lib 模块不得 import 服务端 fs。

## 5. 认证与权限 UI

- 登录页代理平台登录；cookie HttpOnly。
- `/api/webauth/me` 决定角色；普通用户隐藏 Host/全局配置/管理员 tab。
- 管理员支持视图明确标注“他人会话，只读/归属”。
- 未信任项目在 Skills/Agents/MCP/Plugins 操作前弹出信任提示。
- 设置页资源按 project/user/global 分组；普通用户不能选 global/quick MCP。

## 6. 配置与持久化

- 服务端是事实源；localStorage 只做首屏缓存（主题/语言/面板尺寸）。
- `settings-dirty` 守卫：未保存离开提示；项目配置写锁失败显示 409。
- 路径/真实工作目录不展示给普通用户；只显示项目名/公开路径。
- 文件面板拖放移动、上传限额、远程预览的细节见对应专题文档。

## 7. 性能约定

- 会话列表服务端缓存 + 按空间失效；不要全量轮询。
- 长列表虚拟化（会话/消息/工具卡）；工具卡进入动画有上限。
- 大文件/大 JSON 用 worker/懒加载；避免主线程解析卡死。
- SSE 流式内容区禁用 transform 动画。
- 内存守卫会驱逐空闲会话；前端对 `session gone` 要可恢复。

## 8. i18n

- 只允许英文 dot-key；三文件键集一致（registry 测试强制）。
- 缺键回退 locale→en→key；禁止中文直键。
- 设置页两套样式族：资源页 `SettingsUi Config*`，表单页 `settings-general`；不要混用。
- 平台术语统一：项目/会话/执行模式/工作区/模型/凭据/Agent。

## 9. 测试

- 组件测试：`components/*.test.mjs`，renderToStaticMarkup/源码断言。
- 行为测试：hooks、API 路由测试、`lib/*.test.mjs`。
- 浏览器 E2E：`e2e_playwright`（host/auth/live 三世界）。
- 视觉规则变更必须同步 `DESIGN.md`；文案变更同步三语文件。

## 10. 相关文档

- [PLATFORM.md](./PLATFORM.md)
- [multi-user-and-modes-design.md](./multi-user-and-modes-design.md)
- [session-access-and-tool-bridge.md](./session-access-and-tool-bridge.md)
- [全流程测试方案.md](./全流程测试方案.md)
- 仓库根 `DESIGN.md`（视觉规范）
