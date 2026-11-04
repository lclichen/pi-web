import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "./atomic-write";
import { deploymentQuickMcpPath } from "./quick-mcp";
import { isUserScopedConfig, userMcpConfigPath } from "./user-config";
import type {
  ConfigScope,
  McpConfigDiagnostic,
  McpConfigDocument,
  McpServerInfo,
  McpSettings,
  McpTransport,
  ServerEntry,
} from "./api-types";

export function mcpConfigPath(cwd: string, scope: ConfigScope, userId?: number): string {
  if (scope === "project") return join(cwd, ".pi", "mcp.json");
  if (scope === "user") {
    if (!isUserScopedConfig(userId)) {
      throw new Error("User MCP config requires a logged-in user");
    }
    return userMcpConfigPath(userId as number);
  }
  if (scope === "quick") {
    // 部署级快速会话专用：复用 dataDir/mcp-quick.json 作为唯一存储
    //（lib/quick-mcp.ts 的 syncQuickMcpConfig 在会话创建时物化到工作区）。
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
    scopeDisabled: Boolean((entry as ServerEntry).disabled),
    sourcePath,
  };
}

/** A project-level tombstone: `{ "name": { "disabled": true } }` with no
 *  server config of its own. It hides a lower-scope server without copying
 *  (or shadowing the display of) its config. */
function isDisabledOnlyEntry(entry: ServerEntry): boolean {
  if (entry.disabled !== true) return false;
  return Object.keys(entry).every((key) => key === "disabled");
}

export interface ReadMcpOptions {
  /** 限定输出的 scope 集合（默认全部）。quick 工具栏只看 project；
   * 非工具栏排除 quick；设置页看全部并标注覆盖。 */
  scopes?: ConfigScope[];
  /** 保留被高优先级遮蔽的低层条目（设置页用——附带 overridden 标记）。 */
  includeShadowed?: boolean;
  /** 请求者：启用 per-user mcp.json（普通用户设置页/会话）。 */
  userId?: number;
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
  const userCandidates = isUserScopedConfig(options?.userId)
    ? [userMcpConfigPath(options!.userId as number)]
    : [];

  const activeScopes =
    options?.scopes ??
    ([...(userCandidates.length > 0 ? (["project", "quick", "user", "global"] as ConfigScope[]) : (["project", "quick", "global"] as ConfigScope[]))]);

  for (const scope of activeScopes) {
    const candidates =
      scope === "project"
        ? [mcpConfigPath(cwd, scope)]
        : scope === "quick"
          ? quickCandidates
          : scope === "user"
            ? userCandidates
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
  // A {disabled:true}-only project entry is a tombstone (project-level
  // override): it hides the real server but must not replace its config in
  // the settings UI. Merge the tombstone into the underlying entry and mark
  // projectOverride so the panel can toggle the override without touching the
  // original config.
  const scopeRank: Record<ConfigScope, number> = { project: 0, quick: 1, user: 2, global: 3 };
  const groups = new Map<string, McpServerInfo[]>();
  for (const s of servers) {
    const list = groups.get(s.name);
    if (list) list.push(s);
    else groups.set(s.name, [s]);
  }
  const deduped: McpServerInfo[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => scopeRank[a.scope] - scopeRank[b.scope]);
    const real = list.find((s) => !isDisabledOnlyEntry(s.entry));
    // A tombstone with no underlying server (e.g. a stale quick-template
    // deny-list entry) has nothing to show; skip it.
    if (!real) continue;
    const tombstone = list.find((s) => scopeRank[s.scope] < scopeRank[real.scope] && isDisabledOnlyEntry(s.entry));
    deduped.push({
      ...real,
      scopeDisabled: Boolean(real.entry.disabled),
      ...(tombstone
        ? { disabled: true, ...(tombstone.scope === "project" ? { projectOverride: true } : {}) }
        : { disabled: Boolean(real.entry.disabled) }),
    });
  }

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

export function createMcpServer(
  cwd: string,
  scope: ConfigScope,
  name: string,
  entry: ServerEntry,
  userId?: number,
): void {
  const path = mcpConfigPath(cwd, scope, userId);
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
  userId?: number,
): void {
  const path = mcpConfigPath(cwd, scope, userId);
  const cfg = loadWritable(path);
  if (!cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" not found in ${scope} scope`);
  }
  cfg.mcpServers[name] = entry;
  persist(path, cfg);
}

export function removeMcpServer(cwd: string, scope: ConfigScope, name: string, userId?: number): void {
  const path = mcpConfigPath(cwd, scope, userId);
  const cfg = loadWritable(path);
  if (!cfg.mcpServers?.[name]) {
    throw new Error(`Server "${name}" not found in ${scope} scope`);
  }
  delete cfg.mcpServers[name];
  persist(path, cfg);
}

/**
 * 工作区级禁用切换（工具栏 / 设置页开关）：写项目级覆盖
 * （.pi/mcp.json 中 { disabled: true }），不碰原始配置（全局/快速 mcp.json）。
 * 与 pi-mcp-adapter 的行为一致——全局/快速条目的自身 disabled 只在管理员
 * 编辑原始配置时修改。
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

export function setMcpServerDisabled(
  cwd: string,
  scope: ConfigScope,
  name: string,
  disabled: boolean,
  userId?: number,
): void {
  const path = mcpConfigPath(cwd, scope, userId);
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
