import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";

/**
 * 项目里可能执行代码/影响会话行为的资源清单（用于 UI 说明"为什么受限"）。
 * 前 7 项与 SDK 的信任清单一致；`mcp.json` 是 pi-web 额外纳入的：MCP
 * stdio server 在 pi-web 进程内启动，属于控制面资源，应当让用户显式确认。
 */
const TRUST_REASON_FILES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "mcp.json",
] as const;

function trustReasons(cwd: string): string[] {
  const configDir = join(cwd, ".pi");
  const reasons: string[] = TRUST_REASON_FILES.filter((name) => existsSync(join(configDir, name)));
  // 仓库根/上级目录的 .agents/skills（SDK 的信任清单包含它）。
  if (existsSync(join(cwd, ".agents", "skills"))) reasons.push(".agents/skills");
  return reasons;
}

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  if (!cwd) return { requiresTrust: false, trusted: true, reasons: [] };
  const reasons = trustReasons(cwd);
  const requiresTrust = reasons.length > 0 || hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true, reasons: [] };

  const trustStore = new ProjectTrustStore(agentDir);
  return {
    requiresTrust: true,
    trusted: trustStore.get(cwd) === true,
    reasons,
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true, reasons: status.reasons ?? [] };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
