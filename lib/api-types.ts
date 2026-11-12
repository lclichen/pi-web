import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./subagents";

export interface SubagentProfilesResponse {
  profiles: SubagentProfile[];
}

export interface SubagentSettingsResponse {
  enabled: boolean;
}

export interface ShellToolSettingsResponse {
  isWindows: boolean;
  powerShellEnabled: boolean;
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
  /** "skillhub" = 内网 SkillHub 结果（安装走 zip 下载，不走 npx skills）。 */
  source?: "skillhub";
  /** SkillHub 结果的定位字段（namespace+slug 唯一）。 */
  namespace?: string;
  slug?: string;
  version?: string;
  summary?: string;
}

export type SkillInstallScope = "global" | "user" | "project";

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

export type SkillUpdateState = "up-to-date" | "update-available" | "unsupported" | "error";

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

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
  /** 触发信任提示的资源（扩展/技能/MCP 等），用于 UI 说明。 */
  reasons: string[];
}

export interface AppUpdateResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  /** catalog（自有更新源）| npm（上游回落）| off（跳过检查）。 */
  source?: "catalog" | "npm" | "off";
  channel?: string;
  /** catalog 命中的目标版本详情（含可下载 framework）。 */
  target?: {
    version: string;
    channel: string;
    releasedAt?: string;
    frameworks: Array<{ kind: "tarball" | "appimage" | "electron"; fileName: string; sizeBytes: number }>;
  };
  /** 当前部署形态（pkg-kind），决定 apply 用哪个 framework。 */
  pkgKind?: "tarball" | "appimage" | "electron";
  /** 本实例是否支持自助应用更新（appRoot/pkgKind 可得时）。 */
  canSelfUpdate?: boolean;
}

export interface UpdateApplyResponse {
  started: boolean;
  statusUrl?: string;
  error?: string;
}

export interface UpdateStatusResponse {
  phase: "idle" | "downloading" | "verifying" | "staging" | "swapping" | "restarting" | "done" | "failed";
  message?: string;
  /** 下载进度（0-1，phase=downloading 时有效）。 */
  progress?: number;
  targetVersion?: string;
  updatedAt?: number;
  error?: string;
}

export interface PushConfigResponse {
  publicKey: string;
}

export type PluginScope = "global" | "user" | "project";
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

export type PluginUpdateState = "update-available" | "up-to-date" | "unsupported" | "error";

export interface PluginUpdateResult {
  source: string;
  scope: PluginScope;
  displayName: string;
  type: "npm" | "git";
  state: PluginUpdateState;
  message?: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  canCheckForUpdates: boolean;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  description?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
  /** Where the entry comes from: settings `packages`, the settings
   * `extensions` array, or an auto-discovered extensions directory. */
  origin?: "package" | "settings" | "directory";
  /** Human label for the origin, e.g. "settings.json · extensions". */
  sourceLabel?: string;
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

// ---- Subagents & MCP management ----

/** MCP 配置作用域：project = 项目 .pi/mcp.json；global = ~/.pi/agent/mcp.json；
 * quick = 部署级快速会话专用（dataDir/mcp-quick.json，仅快速会话可见）。 */
export type ConfigScope = "project" | "user" | "quick" | "global";

export interface AgentInfo {
  name: string;
  /** "builtin" marks the read-only built-in subagents appended by the API. */
  scope: ConfigScope | "builtin";
  filePath: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  maxTurns?: number;
  parseError?: string;
  enabled?: boolean;
  isDefault?: boolean;
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
  /** pi-mcp-adapter 2.20+: MCP protocol era selection. */
  protocolVersion?: "legacy" | "auto" | "2026-07-28";
  /** pi-mcp-adapter 2.35+: opt out of MCP Tasks for this server. */
  tasks?: boolean;
  /** pi-mcp-adapter 2.33+: do not inherit the parent environment (stdio). */
  inheritEnv?: boolean;
  /** pi-mcp-adapter 2.33+: PEM trust bundle for this server origin. */
  caFile?: string;
  /** pi-mcp-adapter 2.13+: per-request header command. */
  requestHeadersCommand?: unknown;
  /** pi-mcp-adapter 2.34+: keep plugin env values literal. */
  literalEnv?: boolean;
  /** pi-mcp-adapter 2.34+: OAuth Client ID Metadata Document URL. */
  clientMetadataUrl?: string;
  /** Per-server direct-tool prefix override. */
  toolPrefix?: McpToolPrefix;
  exposeResources?: boolean;
  directTools?: boolean | string[] | "search";
  /** Include/exclude specific MCP tools/resources by original or prefixed name (2.13.0). */
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  /** Enable metadata-only JSONL protocol tracing for this server (2.13.0). */
  trace?: boolean;
  /** Keep configuration visible without allowing connections or execution (2.12.0). */
  disabled?: boolean;
  /**
   * pi-web 私有：工具护栏声明块（pi-mcp-adapter 忽略未知字段）。
   * 远端模式（sandbox/ssh/local-machine）默认剔除 stdio 服务器（宿主
   * 子进程 = 沙盒逃逸面）；plane:"host" 显式豁免，plane:"workspace"
   * 在远端执行通道（P3）落地前不可用。见 lib/tool-policy.ts。
   */
  piWeb?: McpWebDeclaration;
}

/** pi-web 私有 MCP 声明（docs/dev/tool-guardrails-design.md §5.1）。 */
export interface McpWebDeclaration {
  /** 操作层：host=服务器本机执行（显式豁免），workspace=带工作区语义。 */
  plane?: "host" | "workspace";
  /** 主风险类（P2 起驱动审批/拦截；当前仅记录）。 */
  risk?: "none" | "read" | "write" | "exec" | "network" | "unknown";
  /** 路径参数名（P2：声明后按路径策略检查，MCP 工具接入护栏）。 */
  pathParams?: string[];
  /** 命令参数名（P2）。 */
  commandParams?: string[];
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
  namespaceProxyTools?: boolean;
  exposeResources?: boolean;
  allowInstall?: boolean;
  deferWithMissingMetadata?: boolean;
  ancestorConfigRoots?: string[];
  oauthCredentialStore?: "encrypted-file";
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
  /** Lower-priority entry shadowed by a higher-priority scope (settings page display). */
  shadowed?: boolean;
  entry: ServerEntry;
  transport: McpTransport;
  summary: string;
  directToolsOn: boolean;
  disabled: boolean;
  /** The entry's own disabled flag (ignores a project-level override). */
  scopeDisabled?: boolean;
  /** Effective disable comes from a project-level {disabled:true} tombstone. */
  projectOverride?: boolean;
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
