import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "./atomic-write";
import type {
  ConfigScope,
  McpConfigDiagnostic,
  McpConfigDocument,
  McpServerInfo,
  McpSettings,
  McpTransport,
  ServerEntry,
} from "./api-types";

export function mcpConfigPath(cwd: string, scope: ConfigScope): string {
  if (scope === "project") return join(cwd, ".pi", "mcp.json");
  if (scope === "quick") {
    // 部署级快速会话专用：复用 dataDir/mcp-quick.json 作为唯一存储
    //（lib/quick-mcp.ts 的 syncQuickMcpConfig 在会话创建时物化到工作区）。
    const { deploymentQuickMcpPath } = require("./quick-mcp") as typeof import("./quick-mcp");
    return deploymentQuickMcpPath();
  }
  return join(getAgentDir(), "mcp.json");
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

import { stripJsonc } from "./jsonc";

export { stripJsonc };

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

function toServerInfo(name: string, entry: ServerEntry, scope: ConfigScope, sourcePath: string): McpServerInfo {
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

export interface ReadMcpOptions {
  /** 限定输出的 scope 集合（默认全部）。quick 工具栏只看 project；
   * 非工具栏排除 quick；设置页看全部并标注覆盖。 */
  scopes?: ConfigScope[];
  /** 保留被高优先级遮蔽的低层条目（设置页用——附带 overridden 标记）。 */
  includeShadowed?: boolean;
}

export function readMcpConfig(cwd: string, options?: ReadMcpOptions): McpConfigDocument {
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
  const quickCandidates = [mcpConfigPath(cwd, "quick"), join(agentsDir, "mcp-quick.json")];

  const activeScopes = options?.scopes ?? (["project", "quick", "global"] as ConfigScope[]);

  for (const scope of activeScopes) {
    const candidates =
      scope === "project" ? [mcpConfigPath(cwd, scope)] : scope === "quick" ? quickCandidates : globalCandidates;

    for (const path of candidates) {
      const { config, error } = readRaw(path);
      diagnostics.push(error ? { scope, path, parseError: error } : { scope, path });
      if (!config) continue;
      const mcpServers = config.mcpServers ?? {};
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, entry] of Object.entries(mcpServers)) {
          if (!entry || typeof entry !== "object") continue;
          // Skip disabled servers in the listing (still show in config diagnostics)
          const info = toServerInfo(name, entry as ServerEntry, scope, path);
          if (!options?.includeShadowed) {
            // 正常模式：已被高优先级同名条目占据时跳过（去重在后面统一做）
            servers.push(info);
          } else {
            // 设置页模式：保留所有层——后面去重时低层条目标记 shadowed
            (info as McpServerInfo & { shadowed?: boolean }).shadowed = false;
            servers.push(info);
          }
        }
      }
      if (config.settings && !settings) {
        settings = config.settings;
        settingsScope = scope;
      }
    }
  }

  // Deduplicate by server name with scope priority (pi-mcp-adapter chain:
  // .pi/mcp.json [project] > mcp-quick.json [quick] > agent mcp.json [global]).
  // Higher-priority scope wins; its disabled flag is respected (a project-level
  // { disabled: true } shadows an enabled global entry of the same name).
  const scopeRank: Record<ConfigScope, number> = { project: 0, quick: 1, global: 2 };
  const byName = new Map<string, McpServerInfo>();
  for (const s of servers) {
    const existing = byName.get(s.name);
    if (!existing || scopeRank[s.scope] < scopeRank[existing.scope]) {
      byName.set(s.name, s);
    }
  }
  const deduped = [...byName.values()];

  return { servers: deduped, settings, settingsScope, diagnostics };
}

function loadWritable(path: string): RawMcpConfig {
  const { config, error } = readRaw(path);
  if (error) throw new Error(`${path} contains invalid JSON (${error}). Fix it before editing.`);
  return config ?? { mcpServers: {}, imports: [], settings: {} };
}

function persist(path: string, cfg: RawMcpConfig): void {
  atomicWriteFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function createMcpServer(cwd: string, scope: ConfigScope, name: string, entry: ServerEntry): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  if (cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" already exists in ${scope} scope`);
  }
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[name] = entry;
  persist(path, cfg);
}

export function updateMcpServer(cwd: string, scope: ConfigScope, name: string, entry: ServerEntry): void {
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

/**
 * 工具栏/会话内的禁用切换：写项目级覆盖（.pi/mcp.json 中 { disabled: true }），
 * 不碰原始配置（全局 mcp.json 等）。与 pi-mcp-adapter 的行为一致——
 * 原始配置的禁用只允许在设置页操作。
 * 如果服务器已在项目层有定义，直接改其中的 disabled；否则新建同名覆盖条目。
 */
export function setMcpServerDisabledViaProject(cwd: string, name: string, disabled: boolean): void {
  const projectPath = mcpConfigPath(cwd, "project");
  const cfg = loadWritable(projectPath);
  if (!cfg.mcpServers) cfg.mcpServers = {};
  const existing = cfg.mcpServers[name] as ServerEntry | undefined;
  if (existing) {
    if (disabled) {
      existing.disabled = true;
    } else {
      delete existing.disabled;
      // 如果条目只剩 disabled（无实际配置），删掉整个条目恢复透明
      const keys = Object.keys(existing).filter((k) => k !== "disabled");
      if (keys.length === 0) delete cfg.mcpServers[name];
    }
  } else if (disabled) {
    // 新建覆盖条目（只有 disabled 标记，不含原始凭据）
    cfg.mcpServers[name] = { disabled: true } as ServerEntry;
  }
  persist(projectPath, cfg);
}

export function setMcpServerDisabled(cwd: string, scope: ConfigScope, name: string, disabled: boolean): void {
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

export function writeMcpSettings(cwd: string, scope: ConfigScope, settings: McpSettings): void {
  const path = mcpConfigPath(cwd, scope);
  const cfg = loadWritable(path);
  cfg.settings = settings;
  persist(path, cfg);
}
