import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile }  from "./atomic-write";
import type {
  ConfigScope,
  McpConfigDiagnostic,
  McpConfigDocument,
  McpServerInfo,
  McpSettings,
  McpTransport,
  ServerEntry,
}  from "./api-types";

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

// Strip JSONC-style comments (line // and block) and trailing commas so MCP
// config files with comments are accepted (pi-mcp-adapter 2.13.0 accepts JSONC).
function stripJsonc(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (ch === "\\" && next !== undefined) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

function readRaw(path: string): ReadResult {
  if (!existsSync(path)) return { config: null };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as RawMcpConfig;
    return { config: parsed && typeof parsed === "object" ? parsed : { mcpServers: {} } };
  } catch (e) {
    return { config: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function detectTransport(entry: ServerEntry): McpTransport {
  if (entry.url) return "http";
  if (entry.socket) return "stdio";
  return entry.command ? "stdio" : "http";
}

export function serverSummary(entry: ServerEntry): string {
  if (entry.url) return entry.url;
  if (entry.socket) return `socket:${entry.socket}`;
  if (entry.command) {
    const args = entry.args?.length ? ` ${entry.args.join(" ")}` : "";
    return `${entry.command}${args}`;
  }
  return "(no command, url, or socket)";
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
    disabled: Boolean((entry as ServerEntry).disabled),
    sourcePath,
  };
}

export function readMcpConfig(cwd: string): McpConfigDocument {
  const diagnostics: McpConfigDiagnostic[] = [];
  const servers: McpServerInfo[] = [];
  let settings: McpSettings | undefined;
  let settingsScope: ConfigScope | undefined;

  // Build candidate paths per scope. Global scope also checks ~/.agents/
  // discovery paths added in pi-mcp-adapter 2.13.0.
  const agentsDir = join(homedir(), ".agents");
  const globalCandidates = [
    mcpConfigPath(cwd, "global"),
    join(agentsDir, "mcp.json"),
    join(agentsDir, "mcp", "mcp.json"),
  ];

  for (const scope of ["project", "global"] as ConfigScope[]) {
    const candidates = scope === "project"
      ? [mcpConfigPath(cwd, scope)]
      : globalCandidates;

    for (const path of candidates) {
      const { config, error } = readRaw(path);
      diagnostics.push(error ? { scope, path, parseError: error } : { scope, path });
      if (!config) continue;
      const mcpServers = config.mcpServers ?? {};
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, entry] of Object.entries(mcpServers)) {
          if (!entry || typeof entry !== "object") continue;
          // Skip disabled servers in the listing (still show in config diagnostics)
          servers.push(toServerInfo(name, entry as ServerEntry, scope, path));
        }
      }
      if (config.settings && !settings) {
        settings = config.settings;
        settingsScope = scope;
      }
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

export function setMcpServerDisabled(
  cwd: string,
  scope: ConfigScope,
  name: string,
  disabled: boolean,
): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  if (!cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" not found in ${scope} scope`);
  }
  const entry = cfg.mcpServers[name] as ServerEntry;
  if (disabled) {
    entry.disabled = true;
  } else {
    delete entry.disabled;
  }
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
