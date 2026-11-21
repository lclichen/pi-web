import type { ServerEntry } from "./api-types";

/**
 * A project-scope stdio MCP entry that pi-web hosts on the user's paired
 * machine instead of letting pi-mcp-adapter spawn it on the control plane.
 * Pure helpers so routes, bundle/sync gates, the UI and the runtime extension
 * all agree on the same predicate.
 */
export function isRelayWorkspaceStdio(entry: ServerEntry): boolean {
  if (entry.disabled === true) return false;
  if (!entry.command || entry.url || entry.socket) return false;
  return entry.piWeb?.plane === "workspace";
}

/**
 * Adapter startup must never connect a relay-hosted server:
 *  - `keep-alive` / `eager` connect during adapter initialization, before the
 *    relay extension can take over (that would run user code on the server);
 *  - direct-tool bootstrap connects to fetch missing metadata. We require
 *    `directTools: false` explicitly (not merely undefined, which inherits a
 *    global `settings.directTools: true`).
 *
 * `lazy` and `lazy-keep-alive` are safe: the excluded gateway tool never calls
 * the server, and the relay extension owns all actual calls.
 */
export function relayWorkspaceEntryProblem(entry: ServerEntry): string | null {
  if (!isRelayWorkspaceStdio(entry)) return null;
  if (entry.lifecycle !== undefined && entry.lifecycle !== "lazy" && entry.lifecycle !== "lazy-keep-alive") {
    return `lifecycle 必须为 lazy/lazy-keep-alive（当前 ${entry.lifecycle} 会在适配器启动时尝试在服务器上连接）`;
  }
  if (entry.directTools !== false) {
    return 'directTools 必须显式为 false（否则适配器启动时会为 direct tools 拉取元数据并连接）';
  }
  return null;
}

/** Throw a user-facing error when any relay-hosted entry is unsafe. */
export function assertRelayWorkspaceEntrySafe(entry: ServerEntry): void {
  const problem = relayWorkspaceEntryProblem(entry);
  if (problem) throw new Error(`workspace MCP「${entry.command ?? "?"}」配置不安全：${problem}`);
}
