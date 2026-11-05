/**
 * 工具操作层清单（tool manifest，纯数据 + 纯函数，零 pi 依赖）。
 *
 * 每个进入会话的工具必须在此声明两件事：
 *   1. plane（操作层）——"host"：效果发生在 pi-web 服务器（agent 宿主）上，
 *      不涉及用户工作区内容（会话状态/计划/交互/出网），可直接引入；
 *      "workspace"：作用于工作区内容（文件/命令），必须声明三条远端通道的
 *      执行语义（container-tools / relay-rpc / ssh-exec / bg-channel /
 *      unsupported），unsupported = 该模式不可用（装配层 clamp，绝不静默
 *      回退宿主执行）。
 *   2. 安全挂钩——pathParams（路径参数名，进入路径护栏）与 commandParams
 *      （命令参数名，进入 bash 扫描管线）。
 *
 * 设计：docs/dev/tool-guardrails-design.md（附录 A = 新工具引入规范）。
 * 注册表完备性测试（lib/tool-manifest.test.mjs）保证"代码里注册的工具名
 * 集合 == 此清单"——新增工具不声明即测试失败，这是引入门禁。
 *
 * 不在静态清单内的工具：MCP（<server>_* / 网关 mcp）等运行时动态注册的
 * 工具。它们由 mcp.json 的 "piWeb" 声明块在装配层描述（P1），未声明时
 * 远端模式默认剔除；拦截层对未声明工具保持 passthrough（现状锁定）。
 */

export type ToolPlane = "host" | "workspace";
export type ToolRisk = "none" | "read" | "write" | "exec" | "network" | "meta";
export type ToolOrigin = "builtin" | "amedac-core" | "pi-web" | "extension";
export type SessionModeName = "host" | "quick" | "sandbox" | "ssh" | "local-machine";

/** 远端通道的执行语义。 */
export interface RemoteSemantics {
  sandbox: "container-tools" | "bg-channel" | "unsupported";
  "local-machine": "relay-rpc" | "bg-channel" | "unsupported";
  ssh: "ssh-exec" | "bg-channel" | "unsupported";
}

export interface ToolManifestEntry {
  name: string;
  plane: ToolPlane;
  risk: ToolRisk;
  /** 路径参数名：声明后该参数按路径策略评估（读/写取决于 risk）。 */
  pathParams?: readonly string[];
  /** 命令参数名：声明后走 evaluateBashCommand（写入目标提取 + 内联兜底）。 */
  commandParams?: readonly string[];
  /** plane=workspace 必填：三条远端通道的执行语义。 */
  remote?: RemoteSemantics;
  /** 显式模式限制；缺省 = 声明兼容的全部模式（quick 另受封闭世界钳制）。 */
  modes?: readonly SessionModeName[];
  origin: ToolOrigin;
  /** 引入理由/边界说明（评审留痕）。 */
  notes?: string;
}

/** 7 个编码工具的远端路由：三套同名覆盖扩展均已实现。 */
const CODING_REMOTE: RemoteSemantics = {
  sandbox: "container-tools",
  "local-machine": "relay-rpc",
  ssh: "ssh-exec",
};

const CODING_PATH = ["path"] as const;

/**
 * 全量清单。顺序无意义；名字唯一（测试断言）。
 */
export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  // ---- SDK 内置编码工具（8）—— 三套同名覆盖扩展按模式路由 ----
  {
    name: "read",
    plane: "workspace",
    risk: "read",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
    notes: "编码工具：sandbox=container-tools / local-machine=relay-rpc / ssh=ssh-exec。",
  },
  {
    name: "write",
    plane: "workspace",
    risk: "write",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "edit",
    plane: "workspace",
    risk: "write",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "grep",
    plane: "workspace",
    risk: "read",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "find",
    plane: "workspace",
    risk: "read",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "ls",
    plane: "workspace",
    risk: "read",
    pathParams: CODING_PATH,
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "bash",
    plane: "workspace",
    risk: "exec",
    commandParams: ["command"],
    remote: CODING_REMOTE,
    origin: "builtin",
  },
  {
    name: "powershell",
    plane: "workspace",
    risk: "exec",
    commandParams: ["command"],
    // 诚实声明：三条远端通道均未代理 powershell（三套覆盖只做 7 个编码
    // 工具）。远端会话若出现该工具，其执行位置是宿主服务器——P1 装配层
    // clamp 的目标；声明为 unsupported 使该缺口不可被静默忽略。
    remote: { sandbox: "unsupported", "local-machine": "unsupported", ssh: "unsupported" },
    origin: "builtin",
    notes: "远端未代理（Windows 专属工具）；仅 host/quick 语义成立。",
  },

  // ---- amedac-core 扩展工具 ----
  {
    name: "bg_run",
    plane: "workspace",
    risk: "exec",
    commandParams: ["command"],
    // 后台任务三通道均已实现（bg-channels.ts）；bg_run 在此声明后与 bash
    // 共享同一套命令护栏（此前完全绕过路径护栏——设计文档缺口 G2）。
    remote: { sandbox: "bg-channel", "local-machine": "bg-channel", ssh: "bg-channel" },
    origin: "amedac-core",
  },
  {
    name: "bg_list",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
    notes: "操纵 host 侧后台任务记录；任务本体在各自模式的通道里跑。",
  },
  {
    name: "bg_stop",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
  },
  {
    name: "todo",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
    notes: "会话状态（session entries），不触工作区文件。",
  },
  {
    name: "plan_save",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
    notes: "写 .pi/plans/（自保护清单内）；由扩展自身而非 agent 工具路径写入。",
  },
  {
    name: "enter_plan_mode",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
  },
  {
    name: "exit_plan_mode",
    plane: "host",
    risk: "meta",
    origin: "amedac-core",
  },
  {
    name: "context_status",
    plane: "host",
    risk: "none",
    origin: "amedac-core",
  },

  // ---- pi-web 内联工具 ----
  {
    name: "share_file",
    plane: "host",
    risk: "read",
    pathParams: ["path"],
    origin: "pi-web",
    notes:
      "生成限时下载链接；host 模式读活引用、远程模式读快照。pathParams 使 denyRead（.env/*.key 等）同样阻止分享。",
  },
  {
    name: "Agent",
    plane: "host",
    risk: "meta",
    origin: "pi-web",
    notes: "子代理编排（子会话继承同一工具面与护栏）。",
  },
  {
    name: "get_subagent_result",
    plane: "host",
    risk: "meta",
    origin: "pi-web",
  },
  {
    name: "steer_subagent",
    plane: "host",
    risk: "meta",
    origin: "pi-web",
  },

  // ---- 随包分发的扩展工具（rpiv-ask-user-question）----
  {
    name: "ask_user_question",
    plane: "host",
    risk: "none",
    origin: "extension",
    notes: "交互工具；无工作区副作用。",
  },
];

// ---------------------------------------------------------------------------
// 注册源清单（完备性测试的唯一事实源）。新增注册工具必须同时进入清单。

/** SDK 内置编码工具（与 lib/rpc-manager.ts 的 CODING_TOOL_NAMES 对齐）。 */
export const BUILTIN_CODING_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** amedac-core 注册的工具（index.ts 默认导出注册的扩展）。 */
export const AMEDAC_CORE_TOOL_NAMES = [
  "todo",
  "plan_save",
  "enter_plan_mode",
  "exit_plan_mode",
  "context_status",
  "bg_run",
  "bg_list",
  "bg_stop",
] as const;

/** pi-web 内联注入的工具（lib/extensions/share.ts、lib/subagent-extension.ts）。 */
export const PI_WEB_TOOL_NAMES = [
  "share_file",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
] as const;

/** 随包分发的第三方扩展工具（pi-config/agent/extensions/rpiv-ask-user-question）。 */
export const EXTENSION_TOOL_NAMES = ["ask_user_question"] as const;

/** 静态清单应覆盖的全部注册名 = 四个来源的并集。 */
export const REGISTERED_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_CODING_TOOL_NAMES,
  ...AMEDAC_CORE_TOOL_NAMES,
  ...PI_WEB_TOOL_NAMES,
  ...EXTENSION_TOOL_NAMES,
];

// ---------------------------------------------------------------------------
// 查询辅助（path-guard 与装配层共用）。

const BY_NAME = new Map(TOOL_MANIFEST.map((entry) => [entry.name, entry]));

export function manifestFor(toolName: string): ToolManifestEntry | undefined {
  return BY_NAME.get(toolName);
}

/** 该工具的路径参数名（未声明 = 空 = 不进路径检查）。 */
export function pathParamsFor(toolName: string): readonly string[] {
  return manifestFor(toolName)?.pathParams ?? [];
}

/** 该工具的命令参数名（未声明 = 空 = 不进命令检查）。 */
export function commandParamsFor(toolName: string): readonly string[] {
  return manifestFor(toolName)?.commandParams ?? [];
}

/**
 * 模式兼容性（P1 装配层钳制用）：workspace 工具在远端模式的通道声明为
 * "unsupported" 时不可用；host 工具全模式可用。
 */
export function isToolAllowedInMode(entry: ToolManifestEntry, mode: SessionModeName): boolean {
  if (entry.modes && !entry.modes.includes(mode)) return false;
  if (entry.plane === "host") return true;
  if (mode === "sandbox" || mode === "ssh" || mode === "local-machine") {
    return entry.remote?.[mode] !== "unsupported";
  }
  // host / quick：workspace 工具在 host 直接在服务器 cwd 执行；quick 由
  // 封闭世界钳制单独决定（本函数不放大 quick 的工具面）。
  return true;
}
