/**
 * 路径护栏策略模型（纯函数，CLI / WebUI 双端共享，零 pi 依赖）。
 *
 * 威胁模型 A（防误操作）：Host 模式下防 Agent 改正在使用的代码；SSH /
 * local-machine 模式下防误操作工作区外的文件。非安全边界——bash 解析是
 * best-effort（引号包裹、$() 嵌套、heredoc、cd 追踪不覆盖），强隔离由
 * 沙箱容器 / relay 工作区围栏兜底。
 *
 * 策略与决策都落在项目 .pi/ 下，随配置包导出/导入一起分发：
 *   .pi/path-policy.json           项目策略（文件级替换默认值；自保护清单恒生效）
 *   .pi/path-policy.decisions.json “不再询问”的持久决策（deny 优先随包分发）
 *
 * 评估顺序（可解释）：自保护 → deny 规则 → 持久决策 → allow 规则 →
 * 工作区外按 askOnOutsideWrite 询问或拒绝。
 */

export interface PathPolicy {
  version: 1;
  /** 写入允许清单（工作区相对或绝对 glob；默认 ["."] 整个工作区）。 */
  allowWrite: string[];
  /** 追加的写入拒绝清单（相对/绝对 glob）。 */
  denyWrite: string[];
  /** 追加的读取拒绝清单（凭据等）。 */
  denyRead: string[];
  /** 工作区外写入默认动作：true=询问用户，false=直接拒绝。默认 true。 */
  askOnOutsideWrite?: boolean;
}

export interface PolicyDecisionEntry {
  /** 绝对路径（POSIX）。 */
  path: string;
  decision: "allow" | "deny";
  at: number;
}

export interface PolicyDecisions {
  version: 1;
  entries: PolicyDecisionEntry[];
}

export const PATH_POLICY_FILE = ".pi/path-policy.json";
export const PATH_DECISIONS_FILE = ".pi/path-policy.decisions.json";

/** 自保护清单：策略/决策文件本身 + 运行态目录 + 凭据——任何策略都不可放行。 */
export const SELF_PROTECTED_PATTERNS = [
  ".pi/path-policy.json",
  ".pi/path-policy.decisions.json",
  ".pi/sessions/**",
  ".pi/tmp/**",
  ".pi/bin/**",
  ".pi/cache/**",
  ".pi/plans/**",
  ".pi/auth.json",
  ".pi/ssh.json",
  ".pi/sandbox-platform.json",
  ".ssh/**",
] as const;

export const DEFAULT_POLICY: PathPolicy = {
  version: 1,
  allowWrite: ["."],
  denyWrite: [".env", ".env.*", "*.pem", "*.key", "id_rsa*"],
  denyRead: [".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".git/config"],
  askOnOutsideWrite: true,
};

// ---------------------------------------------------------------------------
// 路径归一化与 glob 匹配（POSIX 优先；** 任意深度，* 段内任意）。

export function normalizePolicyPath(path: string): string {
  const raw = path.replace(/\\/g, "/");
  const trailingSlash = /\/\s*$/.test(raw);
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!raw.startsWith("/")) out.push(".."); // 相对路径的开头 .. 保留字面量
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return "/";
  return (raw.startsWith("/") ? "/" : "") + out.join("/") + (trailingSlash && out.length > 0 ? "" : "");
}

function globToRegExp(pattern: string): RegExp {
  const norm = normalizePolicyPath(pattern);
  if (norm === "/") return /^\/.*$/; // 根模式 = 一切绝对路径
  const segments = norm.split("/").filter((s) => s.length > 0);
  const parts: string[] = ["^"];
  segments.forEach((seg, i) => {
    if (seg === "**") {
      // 匹配零个或多个完整路径段（自带段前导 /）。
      parts.push("(?:/[^/]+)*");
      return;
    }
    const lit = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    parts.push(i === 0 && !norm.startsWith("/") ? lit : "/" + lit);
  });
  parts.push("(?:/[^/]+)*$"); // 模式匹配目录时覆盖其下所有内容
  return new RegExp(parts.join(""));
}

/** absPath（绝对）是否命中 pattern（工作区相对、绝对 glob，或 ~ 字面量）。
 *  注意先拼后归一："." 的相对语义在归一化中会坍缩成根，不能先 normalize。 */
export function matchesPattern(pattern: string, absPath: string, cwd: string): boolean {
  const norm = normalizePolicyPath(absPath);
  const base = normalizePolicyPath(cwd);
  const rawPat = pattern.trim();
  const isAbsolute = rawPat.startsWith("/") || rawPat.startsWith("~");
  const absolutePat = normalizePolicyPath(isAbsolute ? rawPat : `${base}/${rawPat}`);
  return globToRegExp(absolutePat).test(norm);
}

function matchesAny(patterns: readonly string[], absPath: string, cwd: string): boolean {
  return patterns.some((p) => matchesPattern(p, absPath, cwd));
}

// ---------------------------------------------------------------------------
// 策略解析与评估。

export type GuardAction = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask"; reason: string };

/** 解析策略文件内容；缺字段回默认，非法字段忽略（损坏文件不炸会话）。 */
export function parsePathPolicy(raw: string | null | undefined): PathPolicy {
  const policy: PathPolicy = { ...DEFAULT_POLICY, allowWrite: [...DEFAULT_POLICY.allowWrite] };
  if (!raw) return policy;
  try {
    const parsed = JSON.parse(raw) as Partial<PathPolicy>;
    if (Array.isArray(parsed.allowWrite)) {
      policy.allowWrite = parsed.allowWrite.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      if (policy.allowWrite.length === 0) policy.allowWrite = [...DEFAULT_POLICY.allowWrite];
    }
    if (Array.isArray(parsed.denyWrite))
      policy.denyWrite = parsed.denyWrite.filter((p): p is string => typeof p === "string");
    if (Array.isArray(parsed.denyRead))
      policy.denyRead = parsed.denyRead.filter((p): p is string => typeof p === "string");
    if (typeof parsed.askOnOutsideWrite === "boolean") policy.askOnOutsideWrite = parsed.askOnOutsideWrite;
  } catch {
    // 保留默认
  }
  return policy;
}

export function parsePolicyDecisions(raw: string | null | undefined): PolicyDecisions {
  if (!raw) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<PolicyDecisions>;
    if (!Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    const entries = parsed.entries
      .filter((e) => e && typeof e.path === "string" && (e.decision === "allow" || e.decision === "deny"))
      .map((e) => ({
        path: normalizePolicyPath(e.path as string),
        decision: e.decision as "allow" | "deny",
        at: typeof e.at === "number" ? e.at : 0,
      }));
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function evaluatePathAgainstPolicy(
  absPath: string,
  kind: "read" | "write",
  cwd: string,
  policy: PathPolicy,
  decisions: PolicyDecisions,
): GuardAction {
  const norm = normalizePolicyPath(absPath);
  if (matchesAny(SELF_PROTECTED_PATTERNS, norm, cwd)) {
    return {
      action: "deny",
      reason: `路径「${norm}」属于运行时受保护文件（策略/凭据/会话数据），任何策略都不可放行。`,
    };
  }
  const denyList = kind === "write" ? policy.denyWrite : policy.denyRead;
  if (matchesAny(denyList, norm, cwd)) {
    return {
      action: "deny",
      reason: `路径「${norm}」被策略的 ${kind === "write" ? "denyWrite" : "denyRead"} 规则拒绝（保护工作区敏感文件）。如确需操作，请让用户调整 .pi/path-policy.json。`,
    };
  }
  // 决策记录按路径模式匹配：记录目录则覆盖其子树（与规则语义一致）。
  // 多条命中时最新（数组尾部）优先——用户后做的选择覆盖先前的。
  const decision = [...decisions.entries].reverse().find((e) => matchesPattern(e.path, norm, "/"));
  if (decision) {
    if (decision.decision === "deny") {
      return {
        action: "deny",
        reason: `路径「${norm}」已被用户标记为“拒绝且不再询问”（.pi/path-policy.decisions.json）。`,
      };
    }
    return { action: "allow" };
  }
  if (kind === "write" && matchesAny(policy.allowWrite, norm, cwd)) {
    return { action: "allow" };
  }
  if (kind === "read") {
    return { action: "allow" }; // 读默认放开（仅 deny 清单拦截）
  }
  if (policy.askOnOutsideWrite !== false) {
    return { action: "ask", reason: `写入目标「${norm}」在允许的工作区之外。` };
  }
  return {
    action: "deny",
    reason: `写入目标「${norm}」在允许的工作区之外（策略 askOnOutsideWrite=false，直接拒绝）。`,
  };
}

// ---------------------------------------------------------------------------
// bash 命令的写入目标提取（best-effort，威胁模型 A 足够）。

const WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "dd",
  "truncate",
  "shred",
  "mkdir",
  "touch",
  "tee",
  "ln",
  "install",
  "rsync",
]);
const REDIRECT_RE = /(?:^|[\s;|&])(?:\d*>&>?|>>?|&>?)\s*([^\s;|&<>]+)/g;

function looksLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/");
}

/** 从 bash 命令中尽力提取可能的写入目标绝对路径（相对路径按 cwd 解析）。 */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
  const base = normalizePolicyPath(cwd);
  const found = new Set<string>();
  const add = (token: string) => {
    if (!looksLikePath(token)) return;
    let abs = token;
    if (token.startsWith("./") || token.startsWith("../")) abs = `${base}/${token}`;
    else if (token.startsWith("~/")) abs = token; // 主目录模式不展开——按非工作区处理
    found.add(normalizePolicyPath(abs));
  };
  // 1) 重定向目标
  for (const m of command.matchAll(REDIRECT_RE)) add(m[1]);
  // 2) 危险/写入命令的非 flag 实参（v1：不追踪 cd，引号内 token 按空白拆分）
  const tokens = command.split(/[\s;|&]+/).filter(Boolean);
  let pending = false;
  for (const token of tokens) {
    if (WRITE_COMMANDS.has(token) || /^sed$/.test(token)) {
      pending = true;
      continue;
    }
    if (!pending) continue;
    if (token.startsWith("-")) continue; // 标志参数
    add(token);
  }
  return [...found];
}
