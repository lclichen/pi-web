# amedac-core — CLI 与 WebUI 共享的核心会话扩展

单一事实源：本包同时服务两条发布线——

- **CLI（离线包）**：经 pi-config 分发链路（install-pi-config.sh 软链/拷贝）进
  `~/.pi/agent/extensions/amedac-core`，pi 启动器自动发现加载；
- **WebUI（pi-web）**：会话经全局 agentDir 发现加载同一包；仓库源码部署时由
  `lib/session-restore-options.ts` 的 `resolveCoreExtensionPaths()` 兜底指向本目录。
  `pi-web/lib/extensions/*.ts` 是本包源码的 re-export shim（供 UI 导入与 bench
  内联注入保持模块路径）。

注册内容：`todo`（全量写入清单）、`plan_save`、`enter_plan_mode` / `exit_plan_mode`
（+ `/plan`、`/plan-exit`、`/todo-clear` 命令）、`context_status`。

**沙盒模块（2026-10 并入）**：`src/sandbox/` 是原独立仓库
`pi-sandbox-extension`（Apptainer 沙盒平台桥接：read/write/edit/bash/grep/find/ls
路由进容器、容器 LLM provider、`/sandbox-*` 命令）的实现本体，迁入本包统一维护。
它**不在** `index.ts` 主聚合中注册——沙盒工具会改写全部内建工具的执行目标，
必须只在沙盒会话加载。加载入口是同级的薄目录
`../amedac-sandbox/`（仅 package.json + re-export），由 pi-web 经
`PI_WEB_SANDBOX_EXTENSION_PATH` 按需注入沙盒 home，CLI 用户按需软链。

宿主自适应：widget 在 `ctx.mode === "tui"`（CLI）下渲染友好文本行，RPC
（pi-web）下发布 WebUI 胶囊解析的 JSON 行——同一份代码，两种宿主。

维护约定：
- 改动一律改本包 `src/`（pi-web 的 shim 不含逻辑）；
- pi-web 的扩展测试（`lib/extensions/*.test.mjs`）经 shim 测本包源码；
- 无 node_modules 依赖（peer 由 pi 加载器虚拟化），更新 = 替换目录；
- 状态只存会话条目与工作区文件，无宿主专属存储。
