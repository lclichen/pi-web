# pi-web 上游合并评估（2026-09-21）

> 上游 `agegr/pi-web` 自 fork 分叉点以来 136 个新提交；本 fork 领先 201 个提交。
> 已 cherry-pick 6 个零/低冲突提交（✅）；以下为剩余高价值提交的逐项评估。

## 已完成（6 个 cherry-pick）

| 提交 | 内容 | 冲突处理 |
|---|---|---|
| `002400d` | 流式输出首块去重 | 测试文件冲突，取上游新增测试 |
| `974c8bb` | 从有界转录自动命名会话 | 零冲突 |
| `31f0505` | Next.js 代理上传缓冲区 128MB | next.config.ts 冲突，取上游新增 |
| `c04bab7` | UNC 路径保留（文件 API） | 零冲突 |
| `1f79174` | SSE 关闭时正确结束流（防 Next 16 僵尸进程） | instrumentation.ts 手动合并（保 relay 启动 + 加 SSE 关闭）；agent-event-stream.ts 取上游 |
| `0ff1138`（部分） | Session liveness lease 基础设施 | 只取 lib/session-liveness.ts（上游超集）；hook 侧集成暂缓 |

## 剩余高价值提交评估

### 推荐合并（冲突可控，收益明确）

| 提交 | 内容 | 冲突文件 | 评估 |
|---|---|---|---|
| `09383ae` | gzip 大 JSON 响应 | sessions 路由（我们改过） | 手动合并：新文件 lib/json-response.ts 直接取 + 路由调用点合入 |
| `fce666a` | plugins relativePath Windows 分隔符 | plugins 路由（我们改过） | 小改动，手动合入 normalize 调用 |
| `afd2575` | npm 更新不用 npm.cmd shim | lib/plugin-updates.ts（我们改过） | 小改动 |
| `8df5132` | 扩展 widget 顺序保持 | useAgentSession.ts | 需检查我们的 widget 排序改动是否兼容 |
| `c844973` | 响应被截断时显示提示 | ChatWindow + MessageView + i18n | i18n 三语言需手动加键；MessageView 手动合 |

### 需要较大量手动合并（评估后决定）

| 提交 | 内容 | 冲突面 | 评估 |
|---|---|---|---|
| `8cbafdd` | 会话元数据缓存（跨扫描重启） | session-list-scanner + session-reader | 性能改进明显；我们改过这些文件（Windows CRLF 修复），需逐 hunks 合并 |
| `b44017a` | 看到其他 pi 进程写的会话 | rpc-manager + session-reader + e2e | rpc-manager 是我们改动最重的文件，冲突量大 |
| `d11d344` | 工具卡片折叠时显示图片 | MarkdownBody + MessageView | 中等冲突；工具卡片渲染改动 |

### 暂缓（冲突面大或与我们的架构决策冲突）

| 提交 | 内容 | 暂缓原因 |
|---|---|---|
| `237d0ca` | 启用内置子智能体 | **我们硬锁了 isBuiltInSubagentsEnabled()=false，用 tintinweb 替代**——直接合并会激活内置 subagent 工具，与 tintinweb Agent 工具冲突 |
| `c1e544b` | cookie SameSite=Lax | 我们已改登录态（滑动续期 + 90 天上限），cookie 属性需统一处理 |
| `1cbd96f` | 会话搜索（文本跳转+跨窗口同步） | 冲突面最大（AppShell/ChatWindow/SessionSidebar/i18n/hooks 共 15+ 文件），建议单独做一次专用合并 |
| `5f8f47b` | 侧栏窗口化渲染 | SessionSidebar + ChatWindow + e2e；与我们的管理面板按钮改动同区域 |
| `f2d600b` | /auto-compact 命令 | ChatInput + useAgentSession + i18n；ChatInput 我们改过多处 |
| `ed50d88` | 侧栏面板可拖拽调宽 | SessionSidebar + globals.css + i18n；布局改动大 |
| `e5a2434` | Next.js 16.3.5 升级 | 框架升级需独立评估，涉及所有路由/中间件 |

### 子智能体 P0 批次（6 个提交，需整体评估）

`f106531` merge 包含：
- `bbe2f7d` tintinweb profiles 支持
- `2661247` worktree 隔离
- `a31d5c5` 恢复持久化会话
- `b77a25f` 并发排队
- `e3fbbf6` 扩展工具选择器
- `553f2d7` 保留 agent profile 字段

**暂缓原因**：这批与 tintinweb 集成的架构决策深度耦合。我们的 tintinweb fork 已有 UI
中继（subagent-ui.ts）和提示词契约（user_interaction 块），上游的实现可能假设不同的
集成模式。建议在下次 tintinweb 版本升级时一并评估。

## 建议下一步

1. **本周可做**：`09383ae`（gzip）、`fce666a`（plugins Windows）、`afd2575`（npm shim）——三个都是小改动手动合入
2. **下次合并窗口**：`c844973`（截断提示）+ `8cbafdd`（元数据缓存）——中等冲突量
3. **大合并窗口**（或等上游 v0.10）：`1cbd96f`（会话搜索）+ `5f8f47b`（窗口化列表）+ 子智能体批次——建议一次专用会话处理
4. **跳过**：`237d0ca`（内置子智能体——与 tintinweb 架构冲突）、`e5a2434`（Next.js 16 升级——独立评估）
