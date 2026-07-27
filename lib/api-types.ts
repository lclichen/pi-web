export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}

// ---- Subagents & MCP management ----

export type ConfigScope = "project" | "global";

export interface AgentInfo {
  name: string;
  scope: ConfigScope;
  filePath: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  maxTurns?: number;
  parseError?: string;
}

export interface AgentDetail extends AgentInfo {
  systemPrompt: string;
  rawFrontmatter: Record<string, unknown>;
}

// Structured mirror of pi-mcp-adapter ServerEntry (types.ts) — copied, not imported,
// to avoid a direct dependency on the third-party package.
// Keep in sync with pi-mcp-adapter 2.15.0 types.ts.
export interface ServerEntry {
  command?: string;
  args?: string[];
  /** Explicit rmcp-mux Unix-domain socket path (2.15.0). Mutually exclusive with command and url. */
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: unknown;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  toolTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  /** Include/exclude specific MCP tools/resources by original or prefixed name (2.13.0). */
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  /** Enable metadata-only JSONL protocol tracing for this server (2.13.0). */
  trace?: boolean;
  /** Keep configuration visible without allowing connections or execution (2.12.0). */
  disabled?: boolean;
}

export type McpToolPrefix = "server" | "none" | "short" | "mcp";
export type McpHostConfigDiscovery = "off" | "prompt" | "on";

export interface McpTraceSettings {
  enabled?: boolean;
  file?: string;
  maxBytes?: number;
  maxEvents?: number;
}

export interface McpSettings {
  toolPrefix?: McpToolPrefix;
  showStatusIcon?: boolean;
  hostConfigDiscovery?: McpHostConfigDiscovery;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  outputGuard?: boolean | Record<string, number>;
  trace?: McpTraceSettings;
  authRequiredMessage?: string;
  oauthDir?: string;
}

export type McpTransport = "stdio" | "http";

export interface McpServerInfo {
  name: string;
  scope: ConfigScope;
  entry: ServerEntry;
  transport: McpTransport;
  summary: string;
  directToolsOn: boolean;
  sourcePath: string;
}

export interface McpConfigDiagnostic {
  scope: ConfigScope;
  path: string;
  parseError?: string;
}

export interface McpConfigDocument {
  servers: McpServerInfo[];
  settings?: McpSettings;
  settingsScope?: ConfigScope;
  diagnostics: McpConfigDiagnostic[];
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ProbeResult {
  tools: McpTool[];
  error?: string;
  needsAuth?: boolean;
}

export interface McpServerTools {
  server: string;
  scope: ConfigScope;
  transport: McpTransport;
  tools: McpTool[];
  error?: string;
  needsAuth?: boolean;
}

export interface WebPreferences {
  mcpEnabled: boolean;
  subagentsEnabled: boolean;
  labVerifyEnabled: boolean;
}

export const DEFAULT_PREFERENCES: WebPreferences = {
  mcpEnabled: true,
  subagentsEnabled: true,
  labVerifyEnabled: true,
};
