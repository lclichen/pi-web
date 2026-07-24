import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "@/lib/atomic-write";
import type {
  ConfigScope,
  McpConfigDiagnostic,
  McpConfigDocument,
  McpServerInfo,
  McpSettings,
  McpTransport,
  ServerEntry,
} from "@/lib/api-types";

export function mcpConfigPath(cwd: string, scope: ConfigScope): string {
  return scope === "project" ? join(cwd, ".pi", "mcp.json") : join(getAgentDir(), "mcp.json");
}

interface RawMcpConfig {
  mcpServers?: Record<string, ServerEntry>;
  imports?: string[];
  settings?: McpSettings;
  [key: string]: unknown;
}

interface ReadResult {
  config: RawMcpConfig | null;
  error?: string;
}

function readRaw(path: string): ReadResult {
  if (!existsSync(path)) return { config: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RawMcpConfig;
    return { config: parsed && typeof parsed === "object" ? parsed : { mcpServers: {} } };
  } catch (e) {
    return { config: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function detectTransport(entry: ServerEntry): McpTransport {
  return entry.url ? "http" : "stdio";
}

export function serverSummary(entry: ServerEntry): string {
  if (entry.url) return entry.url;
  if (entry.command) {
    const args = entry.args?.length ? ` ${entry.args.join(" ")}` : "";
    return `${entry.command}${args}`;
  }
  return "(no command or url)";
}

export function isDirectToolsOn(entry: ServerEntry): boolean {
  const dt = entry.directTools;
  if (dt === true) return true;
  if (Array.isArray(dt)) return dt.length > 0;
  return false;
}

function toServerInfo(
  name: string,
  entry: ServerEntry,
  scope: ConfigScope,
  sourcePath: string,
): McpServerInfo {
  return {
    name,
    scope,
    entry,
    transport: detectTransport(entry),
    summary: serverSummary(entry),
    directToolsOn: isDirectToolsOn(entry),
    sourcePath,
  };
}

export function readMcpConfig(cwd: string): McpConfigDocument {
  const diagnostics: McpConfigDiagnostic[] = [];
  const servers: McpServerInfo[] = [];
  let settings: McpSettings | undefined;
  let settingsScope: ConfigScope | undefined;

  for (const scope of ["project", "global"] as ConfigScope[]) {
    const path = mcpConfigPath(cwd, scope);
    const { config, error } = readRaw(path);
    diagnostics.push(error ? { scope, path, parseError: error } : { scope, path });
    if (!config) continue;
    const mcpServers = config.mcpServers ?? {};
    if (mcpServers && typeof mcpServers === "object") {
      for (const [name, entry] of Object.entries(mcpServers)) {
        if (!entry || typeof entry !== "object") continue;
        servers.push(toServerInfo(name, entry as ServerEntry, scope, path));
      }
    }
    if (config.settings && !settings) {
      settings = config.settings;
      settingsScope = scope;
    }
  }

  return { servers, settings, settingsScope, diagnostics };
}

function loadWritable(path: string): RawMcpConfig {
  const { config, error } = readRaw(path);
  if (error) throw new Error(`${path} contains invalid JSON (${error}). Fix it before editing.`);
  return config ?? { mcpServers: {}, imports: [], settings: {} };
}

function persist(path: string, cfg: RawMcpConfig): void {
  atomicWriteFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function createMcpServer(
  cwd: string,
  scope: ConfigScope,
  name: string,
  entry: ServerEntry,
): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  if (cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" already exists in ${scope} scope`);
  }
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[name] = entry;
  persist(path, cfg);
}

export function updateMcpServer(
  cwd: string,
  scope: ConfigScope,
  name: string,
  entry: ServerEntry,
): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  if (!cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" not found in ${scope} scope`);
  }
  cfg.mcpServers[name] = entry;
  persist(path, cfg);
}

export function removeMcpServer(cwd: string, scope: ConfigScope, name: string): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  if (!cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" not found in ${scope} scope`);
  }
  delete cfg.mcpServers[name];
  persist(path, cfg);
}

export function writeMcpSettings(
  cwd: string,
  scope: ConfigScope,
  settings: McpSettings,
): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  cfg.settings = settings;
  persist(path, cfg);
}
