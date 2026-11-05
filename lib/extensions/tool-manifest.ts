/**
 * Re-export shim — the implementation lives in
 * pi-config/agent/extensions/amedac-core/src/tool-manifest.ts（工具操作层
 * 声明的单一事实源，与 CLI 分发共用）。pi-web 服务端路由与 UI 类型导入
 * 走这个稳定模块路径（同 lib/extensions/path-guard.ts 的模式）。
 */
export * from "../../pi-config/agent/extensions/amedac-core/src/tool-manifest.ts";
