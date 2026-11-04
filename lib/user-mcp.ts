import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { dataDir } from "./mode-homes";
import { isUserScopedConfig, userMcpConfigPath } from "./user-config";

interface RawMcpFile {
  mcpServers?: Record<string, unknown>;
  imports?: unknown[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJson(path: string): RawMcpFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as RawMcpFile) : null;
  } catch {
    return null;
  }
}

function mergeMcp(base: RawMcpFile, override: RawMcpFile): RawMcpFile {
  return {
    ...base,
    ...override,
    mcpServers: { ...(base.mcpServers ?? {}), ...(override.mcpServers ?? {}) },
    ...(base.imports || override.imports
      ? { imports: [...(base.imports ?? []), ...(override.imports ?? [])] }
      : {}),
    ...(base.settings || override.settings
      ? { settings: { ...(base.settings ?? {}), ...(override.settings ?? {}) } }
      : {}),
  };
}

/**
 * The MCP adapter accepts one global config path (`--mcp-config`). For a web
 * user with a personal MCP pool, materialize a merged global+user file and
 * point that session's adapter at it; project .pi/mcp.json still wins inside
 * the adapter. Returns null when the user has no personal MCP config, keeping
 * the normal global path.
 */
export function ensureUserMcpRuntime(userId: number): string | null {
  if (!isUserScopedConfig(userId)) return null;
  const userFile = userMcpConfigPath(userId);
  if (!existsSync(userFile)) return null;

  const globalFile = join(getAgentDir(), "mcp.json");
  const globalConfig = readJson(globalFile) ?? {};
  const userConfig = readJson(userFile);
  if (!userConfig) return null;

  const runtimeDir = join(dataDir(), "user-runtime", `u${userId}`);
  mkdirSync(runtimeDir, { recursive: true });
  const target = join(runtimeDir, "mcp.json");
  writePrivateFileAtomicSync(target, `${JSON.stringify(mergeMcp(globalConfig, userConfig), null, 2)}\n`);
  return target;
}
