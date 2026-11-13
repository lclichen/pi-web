/**
 * 路径护栏策略模型（纯函数，CLI / WebUI 双端共享，零 pi 依赖）。
 *
 * 威胁模型 A（防误操作）：Host 模式下防 Agent 改正在使用的代码；SSH /
 * local-machine / sandbox 模式下防误操作工作区外的文件。非安全边界——bash
 * 解析是 best-effort（引号内的解释器代码、`eval`、未跟踪的 cd 等只能尽力
 * 覆盖），强隔离由沙箱容器 / relay 工作区围栏兜底。
 *
 * 策略与决策都落在项目 .pi/ 下，随配置包导出/导入一起分发：
 *   .pi/path-policy.json           项目策略（文件级替换默认值；自保护清单恒生效）
 *   .pi/path-policy.decisions.json “不再询问”的持久决策（deny 优先随包分发）
 *   .pi/path-policy.scope.json     运行时路径空间（远程模式；不导出）
 *
 * 评估顺序（可解释）：自保护 → deny 规则 → 持久决策 → allow 规则 →
 * 工作区外按 askOnOutsideWrite 询问或拒绝。
 *
 * 路径空间：Host / quick 模式下工具路径与策略同为服务器路径，无需映射；
 * sandbox / ssh / local-machine 模式下工具路径是"远端工作区路径"（如
 * /workspace/src/a.ts），而策略文件在服务器侧项目 home。path-scope 把远端
 * 工作区根映射回项目 home，使 deny/allow 规则（相对 glob）在远程模式同样
 * 成立；工作区外的远端绝对路径保持原样，按"工作区外"处理。
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

/** 远程会话的工具路径空间：workspaceRoot 是工具眼里的工作区绝对路径。 */
export interface PathScope {
  version: 1;
  mode: "sandbox" | "local-machine" | "ssh";
  workspaceRoot: string;
}

export const PATH_POLICY_FILE = ".pi/path-policy.json";
export const PATH_DECISIONS_FILE = ".pi/path-policy.decisions.json";
export const PATH_SCOPE_FILE = ".pi/path-policy.scope.json";

/** 自保护清单：策略/决策文件本身 + 运行态目录 + 凭据——任何策略都不可放行。 */
export const SELF_PROTECTED_PATTERNS = [
  ".pi/path-policy.json",
  ".pi/path-policy.decisions.json",
  ".pi/path-policy.scope.json",
  ".pi/guardrail-audit.jsonl",
  ".pi/guardrail-audit.jsonl.1",
  ".pi/sessions/**",
  ".pi/tmp/**",
  ".pi/bin/**",
  ".pi/cache/**",
  ".pi/plans/**",
  ".pi/.sync-backups",
  ".pi/.sync-backups/**",
  ".pi/auth.json",
  ".pi/ssh.json",
  ".pi/sandbox-platform.json",
  ".ssh/**",
] as const;

/** Background-task logs are runtime state, but the model is explicitly told to
 *  read them (bg_run contract). Read-only exception; writes stay denied. */
const BG_LOG_READ_PATTERNS = [".pi/tmp/bg", ".pi/tmp/bg/**"] as const;

export const DEFAULT_POLICY: PathPolicy = {
  version: 1,
  allowWrite: ["."],
  // Chat attachments are immutable inputs; tools may read them but must copy
  // to a workspace directory before modifying. The WebUI/server writes bypass
  // this agent-side guard.
  denyWrite: [".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".pi/attachments", ".pi/attachments/**"],
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
/** Windows 盘符绝对路径（C:/ 或 C:\）——决策/策略里常见，必须按绝对模式处理。 */
function isWindowsDriveAbsolute(value: string): boolean {
  if (value.length < 3) return false;
  const code = value.charCodeAt(0);
  const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return letter && value[1] === ":" && (value[2] === "/" || value.charCodeAt(2) === 92);
}

export function matchesPattern(pattern: string, absPath: string, cwd: string): boolean {
  const norm = normalizePolicyPath(absPath);
  const base = normalizePolicyPath(cwd);
  const rawPat = pattern.trim();
  const isAbsolute = rawPat.startsWith("/") || rawPat.startsWith("~") || isWindowsDriveAbsolute(rawPat);
  const absolutePat = normalizePolicyPath(isAbsolute ? rawPat : `${base}/${rawPat}`);
  return globToRegExp(absolutePat).test(norm);
}

function matchesAny(patterns: readonly string[], absPath: string, cwd: string): boolean {
  return patterns.some((p) => matchesPattern(p, absPath, cwd));
}

// ---------------------------------------------------------------------------
// 路径空间（远程模式）

/** 解析 `.pi/path-policy.scope.json`；损坏/缺字段视为无映射。 */
export function parsePathScope(raw: string | null | undefined): PathScope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PathScope>;
    if (typeof parsed.workspaceRoot !== "string" || parsed.workspaceRoot.trim().length === 0) return null;
    const root = normalizePolicyPath(parsed.workspaceRoot);
    // "/" = 远端工作区就是整个文件系统：映射没有围栏意义。
    if (root === "/") return null;
    const mode =
      parsed.mode === "sandbox" || parsed.mode === "local-machine" || parsed.mode === "ssh" ? parsed.mode : "ssh";
    return { version: 1, mode, workspaceRoot: root };
  } catch {
    return null;
  }
}

/** 把工具路径映射进策略空间：工作区内 → `<cwd>/<相对>`；工作区外原样保留。 */
export function mapToolPathToPolicy(absPath: string, cwd: string, scope?: PathScope | null): string {
  const norm = normalizePolicyPath(absPath);
  if (!scope) return norm;
  const root = normalizePolicyPath(scope.workspaceRoot);
  if (root === "/") return norm;
  if (norm === root) return normalizePolicyPath(cwd);
  if (norm.startsWith(root + "/")) return normalizePolicyPath(`${cwd}/${norm.slice(root.length + 1)}`);
  return norm;
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
  scope?: PathScope | null,
): GuardAction {
  // 展示用工具路径（远端路径）；判定用映射后的策略路径。
  const display = normalizePolicyPath(absPath);
  const norm = mapToolPathToPolicy(absPath, cwd, scope);
  if (matchesAny(SELF_PROTECTED_PATTERNS, norm, cwd)) {
    // bg_run tells the model to read <cwd>/.pi/tmp/bg/<task>.log. Keep the
    // write side fully protected while allowing that read path.
    if (!(kind === "read" && matchesAny(BG_LOG_READ_PATTERNS, norm, cwd))) {
      return {
        action: "deny",
        reason: `路径「${display}」属于运行时受保护文件（策略/凭据/会话数据），任何策略都不可放行。`,
      };
    }
  }
  const denyList = kind === "write" ? policy.denyWrite : policy.denyRead;
  if (matchesAny(denyList, norm, cwd)) {
    return {
      action: "deny",
      reason: `路径「${display}」被策略的 ${kind === "write" ? "denyWrite" : "denyRead"} 规则拒绝（保护工作区敏感文件）。如确需操作，请让用户调整 .pi/path-policy.json；不要重复尝试同一路径。`,
    };
  }
  // 决策记录按路径模式匹配：记录目录则覆盖其子树（与规则语义一致）。
  // 多条命中时最新（数组尾部）优先——用户后做的选择覆盖先前的。
  const decision = [...decisions.entries].reverse().find((e) => matchesPattern(e.path, norm, "/"));
  if (decision) {
    if (decision.decision === "deny") {
      return {
        action: "deny",
        reason: `路径「${display}」已被用户标记为“拒绝且不再询问”（.pi/path-policy.decisions.json）；不要重复尝试同一路径。`,
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
    return { action: "ask", reason: `写入目标「${display}」在允许的工作区之外。` };
  }
  return {
    action: "deny",
    reason: `写入目标「${display}」在允许的工作区之外（策略 askOnOutsideWrite=false，直接拒绝）；不要重复尝试同一路径。`,
  };
}

// ---------------------------------------------------------------------------
// bash 命令的写入目标提取（best-effort，威胁模型 A 足够）。
//
// 覆盖范围（v2）：
//   · 重定向（> >> >| &>，含无空格写法）；/dev/null 等设备写忽略；
//   · 破坏/写命令的**所有**非 flag 操作数（含裸相对名——v1 只认 ./ / ../ ~
//     前缀，`rm .env`、`rm -rf secrets` 直接漏检）；
//   · cd/pushd 追踪（同一命令串内切换相对基准）；
//   · sed -i、dd of=、find -delete、git -C/clean、cp/mv -t；
//   · 内联执行（$()、反引号、heredoc、sh -c、python -c、eval）时，对命令原文
//     做受保护文件名的字面量扫描（无法解析代码，只能兜住显式路径）。
// 未覆盖（有意）：任意解释器代码、变量展开后的路径、make/npm 等构建工具的
// 间接写入——这是行为护栏，不是安全边界。

const WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
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
  "chmod",
  "chown",
  // PowerShell cmdlets（Windows host / 本地机器 CLI；别名 rm/mv/cp 已在上）
  "remove-item",
  "move-item",
  "copy-item",
  "new-item",
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
  "rename-item",
]);

/** 写入没有实际效果的设备/伪文件（重定向到这些不应拦截）。 */
const DEVICE_SINKS = /^\/(?:dev\/(?:null|stdout|stderr|tty|zero|random|urandom)|proc\/self\/fd\/\d+|dev\/fd\/\d+)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 命令前缀（sudo/env 包装），跳过它们再识别真实命令。 */
const COMMAND_PREFIXES = new Set(["sudo", "doas", "command", "builtin", "nohup", "time", "env"]);

/** 按顶层分隔符切段（引号/括号内不切）。 */
function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let parens = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      parens += 1;
      buf += "$(";
      i += 1;
      continue;
    }
    if (ch === "(") parens += 1;
    if (ch === ")" && parens > 0) parens -= 1;
    if (parens === 0) {
      if (ch === ";" || ch === "\n") {
        out.push(buf);
        buf = "";
        continue;
      }
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        out.push(buf);
        buf = "";
        i += 1;
        continue;
      }
      // `>|` / `2>|` 是 noclobber 强制覆盖重定向，不是管道——先于裸 | 分段，
      // 否则写入目标会留在下一段里丢失（redirectTargets 的 >| 分支才可达）。
      if (ch === "|" && command[i - 1] === ">") {
        buf += ch;
        continue;
      }
      if (ch === "|" || ch === "&") {
        out.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

/** 段内分词（去引号；保留普通字符）。 */
function tokenizeShell(segment: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };
  for (const ch of segment) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    buf += ch;
  }
  push();
  return tokens;
}

/** 段内重定向目标（引号内不算；>& / /dev/null 忽略）。 */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;
    if (segment[i - 1] === "<") continue; // heredoc `<<` / here-string `<<<`
    let j = i + 1;
    if (segment[j] === "&") continue; // `>&2` fd 复制
    if (segment[j] === ">") j += 1; // `>>`
    if (segment[j] === "|") j += 1; // `>|`
    while (segment[j] === " " || segment[j] === "\t") j += 1;
    if (segment[j] === "&" || segment[j] === "(") continue; // `&>` 开头/进程替换
    let end = j;
    let innerQuote: '"' | "'" | null = null;
    while (end < segment.length) {
      const c = segment[end];
      if (innerQuote) {
        if (c === innerQuote) innerQuote = null;
        end += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        innerQuote = c;
        end += 1;
        continue;
      }
      if (/[\s;&|<>()]/.test(c)) break;
      end += 1;
    }
    const raw = segment.slice(j, end);
    if (raw.length > 0 && !DEVICE_SINKS.test(raw)) out.push(raw);
    i = end - 1;
  }
  return out;
}

/** 写命令的操作数（跳过 flag；-t 的目标目录算操作数）。 */
function writeOperands(cmd: string, args: string[]): string[] {
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg.length > 1) {
      // 取值型 flag：值不是路径（-t/--target-directory 例外，它就是目标目录）。
      if (arg === "-t" || arg === "--target-directory") {
        if (i + 1 < args.length) operands.push(args[++i]);
      } else if (arg === "-m" || arg === "--mode" || arg === "-o" || arg === "--owner" || arg === "-g" || arg === "--group") {
        i += 1;
      }
      continue;
    }
    operands.push(arg);
  }
  // 命令自身的名字不参与（cp/mv 的第一个操作数是源，也要查——源可能是工作区外）。
  void cmd;
  return operands;
}

/** 从 tokens 里跳过命令前缀，返回真实命令下标。 */
function commandIndex(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (COMMAND_PREFIXES.has(t) || ENV_ASSIGNMENT.test(t)) {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

function resolveToken(token: string, base: string): string {
  if (DEVICE_SINKS.test(token)) return token;
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("/")) return normalizePolicyPath(token);
  if (token === "~" || token.startsWith("~/")) return normalizePolicyPath(token); // 主目录字面量：按工作区外处理
  return normalizePolicyPath(`${base}/${token}`);
}

/** 从 bash 命令中尽力提取可能的写入目标绝对路径（相对路径按当前 cd 基准解析）。 */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
  let base = normalizePolicyPath(cwd);
  const found = new Set<string>();
  const add = (token: string) => {
    const t = token.trim();
    if (t.length === 0 || t.startsWith("-") || t.startsWith("$") || t.includes("$(") || t.includes("`")) return;
    if (DEVICE_SINKS.test(t)) return;
    found.add(resolveToken(t, base));
  };

  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;
    const cmdIdx = commandIndex(tokens);
    const cmd = tokens[cmdIdx];
    if (!cmd) continue;
    const cmdLower = cmd.toLowerCase();
    const args = tokens.slice(cmdIdx + 1);

    // cd/pushd：更新相对基准（不追踪子 shell，尽力而为）。
    if (cmdLower === "cd" || cmdLower === "pushd" || cmdLower === "set-location") {
      const target = args.find((a) => !a.startsWith("-"));
      if (target && !target.startsWith("$") && !target.includes("`")) base = resolveToken(target, base);
      continue;
    }

    for (const target of redirectTargets(segment)) add(target);

    if (cmdLower === "dd") {
      for (const arg of args) {
        if (arg.startsWith("of=")) add(arg.slice(3));
      }
      continue;
    }
    if (cmdLower === "find") {
      if (!args.includes("-delete")) continue;
      const roots: string[] = [];
      for (const arg of args) {
        if (arg.startsWith("-")) break;
        roots.push(arg);
      }
      for (const root of roots.length > 0 ? roots : ["."]) add(root);
      continue;
    }
    if (cmdLower === "sed") {
      const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place="));
      if (!inPlace) continue;
      const ops = writeOperands(cmd, args);
      // 第一个操作数是表达式，其余是文件。
      for (const file of ops.slice(1)) add(file);
      continue;
    }
    if (cmdLower === "git") {
      const cIndex = args.indexOf("-C");
      if (cIndex !== -1 && args[cIndex + 1]) add(args[cIndex + 1]);
      // clean/reset/checkout/rm 都只改仓库内文件：仓库根 = -C 目录或当前基准。
      if (args.some((a) => a === "clean" || a === "reset" || a === "checkout" || a === "rm")) {
        add(cIndex !== -1 && args[cIndex + 1] ? args[cIndex + 1] : ".");
      }
      continue;
    }
    if (WRITE_COMMANDS.has(cmdLower)) {
      for (const operand of writeOperands(cmd, args)) add(operand);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// 内联执行兜底：命令串里有 $() / 反引号 / heredoc / sh -c / python -c / eval
// 时，路径可能藏在代码里。解析代码不现实，退化为"受保护文件名出现在原文"。

const INLINE_EXEC_RE =
  /\$\(|`|<<-?\s*['"]?[A-Za-z_]|(?:^|[\s;|&])(?:ba|z|da|k)?sh\s+-c(?:[\s"']|$)|(?:^|[\s;|&])(?:python[0-9.]*|node|perl|ruby|php)\s+-[ce](?:[\s"']|$)|(?:^|[\s;|&])eval(?:[\s"']|$)/;

export function bashUsesInlineExecution(command: string): boolean {
  return INLINE_EXEC_RE.test(command);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 受保护模式的字面量核心：`*.pem` → `.pem`，`secrets/**` → `secrets`。 */
function literalCore(pattern: string): string | null {
  let core = pattern
    .replace(/^\*\*\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/[./]+$/, "")
    .trim();
  if (core.length < 3) return null;
  return core;
}

/**
 * 内联代码里的显式受保护文件名扫描。只覆盖"像具体文件的名字"（含 `.` 或
 * `/`）与自保护清单——目录名如 `build` 太泛，扫描会造成大量误报。
 */
export function findInlineProtectedPath(
  command: string,
  policy: PathPolicy,
): { path: string; kind: "read" | "write" } | null {
  const candidates: Array<{ pattern: string; kind: "read" | "write" }> = [
    ...policy.denyWrite.map((p) => ({ pattern: p, kind: "write" as const })),
    ...policy.denyRead.map((p) => ({ pattern: p, kind: "read" as const })),
  ];
  const seen = new Set<string>();
  const test = (pattern: string, kind: "read" | "write", always = false): { path: string; kind: "read" | "write" } | null => {
    const core = literalCore(pattern);
    if (!core || seen.has(core)) return null;
    seen.add(core);
    if (!always && !/[./]/.test(core)) return null;
    // `.env` / `.key` 这类后缀式核心允许前面是文件名（server.key）；其它
    // 核心（如 secrets/x）要求两侧都是路径分隔/标点边界。
    const lead = core.startsWith(".") ? "" : "(^|[^A-Za-z0-9_.-])";
    const re = new RegExp(`${lead}${escapeRegExp(core)}($|[^A-Za-z0-9_.-])`);
    return re.test(command) ? { path: core, kind } : null;
  };
  for (const { pattern, kind } of candidates) {
    const hit = test(pattern, kind);
    if (hit) return hit;
  }
  for (const pattern of SELF_PROTECTED_PATTERNS) {
    const hit = test(pattern, "write", true);
    if (hit) return hit;
  }
  return null;
}

export interface BashScanResult {
  verdict: GuardAction;
  /** 命中的工具路径（用于决策/展示）；内联扫描命中时为字面量核心。 */
  target?: string;
}

// ---------------------------------------------------------------------------
// 灾难命令分类（策略不可放行的硬拒绝层，地位等同自保护清单）。
//
// 双通道（借鉴 QwenPaw safety_checks.py，见 docs/dev/qwenpaw-guardrails-
// reference.md §2.2）：
//   ① 结构模式：下载即执行、fork bomb、格式化、块设备写入（正则）；
//   ② 目标分类：从 rm 类命令提取操作数 → 展开 ~/$HOME 字面量 →
//      normalize → 按路径段分类（根/home 根/系统树/盘符根）。
// 与路径策略解耦：命中即 deny，不可 ask、不可被项目策略放行。
// 这是行为护栏不是安全边界（解释器间接执行仍依赖沙箱/围栏）。

const CATASTROPHIC_COMMAND_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
    reason: "下载即执行（curl/wget | sh）",
  },
  {
    // 经典 fork bomb（:(){ :|:& };: 及其函数名变体）。
    re: /(?:^|[\s;])(?:\w+|:)\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*[:.\w]+/,
    reason: "fork bomb",
  },
  { re: /\bmkfs(?:\.\w+)?\b/i, reason: "格式化文件系统（mkfs）" },
  {
    re: /\bdd\b[^|;&\n]*\bof=\/dev\/(?!(?:null|zero|stdout|stderr|tty|fd\/))/i,
    reason: "向块设备写入（dd of=/dev/…）",
  },
  {
    re: /(?:^|[\s;|&])>{1,2}\s*\/dev\/(?:sd|hd|nvme|vd|xvd|disk|mmcblk)\w*/i,
    reason: "重定向写入块设备",
  },
  { re: /\bformat\s+[a-z]:/i, reason: "格式化磁盘（format X:）" },
];

/** rm 类命令（destructive 目标分类只对它们提取操作数）。 */
const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "unlink", "remove-item", "del", "rd", "deltree", "find"]);

/** POSIX 顶层系统树：递归删除其根本身即灾难。 */
const POSIX_SYSTEM_TREES = new Set([
  "boot",
  "dev",
  "etc",
  "usr",
  "bin",
  "sbin",
  "lib",
  "lib64",
  "opt",
  "proc",
  "sys",
  "var",
  "private",
  "system",
  "library",
  "applications",
  "mnt",
  "media",
  "run",
  "srv",
]);

const WINDOWS_SYSTEM_DIRS = new Set(["windows", "program files", "program files (x86)", "programdata"]);

/** 递归/强制语义的 flag（rm -rf / -r / --recursive / PowerShell -Recurse / cmd /s）。 */
const RECURSIVE_FLAG_RE = /^(?:-[a-z]*r[a-z]*|--recursive|\/s)$/i;

/** 展开不了的 home 等价物（字面量按"home 根"处理，不做真实环境展开）。 */
function homeRootRemainder(lower: string): string | null {
  const prefixes = ["~/", "$home/", "${home}/", "$env:userprofile\\", "$env:userprofile/", "%userprofile%/"];
  if (lower === "~" || lower === "$home" || lower === "${home}" || lower === "$env:userprofile" || lower === "%userprofile%") {
    return "";
  }
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) return lower.slice(prefix.length);
  }
  return null;
}

function isGlobOnly(segment: string): boolean {
  return /^[^A-Za-z0-9._-]*$/.test(segment);
}

/** 单个目标 token 的灾难分类（null = 不构成灾难）。 */
export function catastrophicTargetReason(token: string): string | null {
  const raw = token.trim().replace(/^["']+|["']+$/g, "");
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // home 等价物（~/$HOME/%USERPROFILE% 等字面量）。
  const homeRest = homeRootRemainder(lower);
  if (homeRest !== null) {
    const segs = homeRest.split(/[\\/]+/).filter((s) => s && s !== ".");
    if (segs.length === 0) return "home 根";
    if (segs.length === 1 && isGlobOnly(segs[0])) return "home 根通配";
    if (segs.includes("..")) return "home 根上级（.. 攀升）";
    return null;
  }
  if (/^(?:%system(?:root|drive)%|\$env:system(?:root|drive))$/i.test(lower)) return "系统盘根";

  const norm = raw.replace(/\\/g, "/");

  // Windows 盘符：C:\ / C:\Windows / C:\Users\<用户> / C:\Users\alice\proj（后者正常）。
  const drive = norm.match(/^([a-z]:)(?:\/|$)(.*)$/i);
  if (drive) {
    const rest = drive[2].replace(/\/+$/, "");
    const segs = rest.split("/").filter((s) => s && s !== ".");
    if (segs.length === 0) return `盘符根（${drive[1]}\\）`;
    if (segs.length === 1 && isGlobOnly(segs[0])) return `盘符根通配（${drive[1]}\\*）`;
    const first = segs[0].toLowerCase();
    if (first === "users") {
      if (segs.length === 1) return "用户目录根（C:\\Users）";
      if (segs.length === 2 && isGlobOnly(segs[1])) return "用户目录根通配（C:\\Users\\*）";
      if (segs.length === 2) return "用户 home 根（C:\\Users\\<用户>）";
      return null;
    }
    if (WINDOWS_SYSTEM_DIRS.has(first)) return `Windows 系统目录（${drive[1]}\\${segs[0]}）`;
    return null;
  }
  if (!norm.startsWith("/")) return null;

  // WSL 挂载盘：/mnt/c[/...]。
  const wsl = norm.match(/^\/mnt\/([a-z])(?:\/|$)(.*)$/i);
  if (wsl) {
    const segs = wsl[2].split("/").filter((s) => s && s !== ".");
    if (segs.length === 0 || (segs.length === 1 && isGlobOnly(segs[0]))) return `Windows 盘符根（/mnt/${wsl[1]}）`;
    const first = segs[0].toLowerCase();
    if (first === "users") {
      if (segs.length === 1) return "用户目录根（/mnt/x/Users）";
      if (segs.length === 2 && isGlobOnly(segs[1])) return "用户目录根通配";
      if (segs.length === 2) return "用户 home 根（/mnt/x/Users/<用户>）";
      return null;
    }
    if (WINDOWS_SYSTEM_DIRS.has(first)) return `Windows 系统目录（/mnt/${wsl[1]}/${segs[0]}）`;
    return null;
  }

  const segs = norm.split("/").filter((s) => s && s !== "." && s !== "..");
  if (segs.length === 0) return "根目录（/）";
  if (isGlobOnly(segs[0])) return "根目录通配（/…）";
  const first = segs[0].replace(/[^A-Za-z0-9._-]/g, "").toLowerCase();
  if (first === "") return "根目录通配（/…）";
  if (first === "home" || first === "users") {
    if (segs.length === 1) return "home 根";
    if (segs.length === 2) {
      if (isGlobOnly(segs[1])) return "home 根通配（所有用户）";
      return "用户 home 根";
    }
    return null;
  }
  if (first === "root" && segs.length === 1) return "root 用户 home 根";
  if (first === "volumes" && segs.length <= 2) return "卷根（/Volumes）";
  if (POSIX_SYSTEM_TREES.has(first) && segs.length === 1) return `系统目录（/${first}）`;
  return null;
}

/** 从命令里提取破坏性命令（rm 类/find -delete）的操作数（保持顺序，去 flag）。
 *  注：分词前把反斜杠归一为正斜杠——分词器按 POSIX 把 `\` 当转义，而
 *  远端 Windows 目标机的路径（C:\Users\…）必须保留段结构才能分类。 */
function destructiveOperands(command: string): string[] {
  const out: string[] = [];
  for (const segment of splitShellSegments(command.replace(/\\/g, "/"))) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;
    const cmdIdx = commandIndex(tokens);
    const cmd = tokens[cmdIdx]?.toLowerCase();
    if (!cmd || !DESTRUCTIVE_COMMANDS.has(cmd)) continue;
    const args = tokens.slice(cmdIdx + 1);
    if (cmd === "find") {
      if (!args.includes("-delete")) continue;
      for (const arg of args) {
        if (arg.startsWith("-")) break;
        out.push(arg);
      }
      continue;
    }
    // 递归/强制 flag 才可能是灾难性删除（rm / 不会成功；rm -rf / 才是）。
    if (!args.some((a) => RECURSIVE_FLAG_RE.test(a))) continue;
    for (const arg of args) {
      if (arg === "--") continue;
      if (arg.startsWith("-") && arg.length > 1) continue;
      out.push(arg);
    }
  }
  return out;
}

const INLINE_WRAP_RE =
  /(?:^|[\s;|&])(?:(?:ba|z|da|k)?sh|powershell|pwsh)\s+(?:-c|-command)\s+([\s\S]+)$/i;
const EVAL_WRAP_RE = /(?:^|[\s;|&])eval\s+([\s\S]+)$/i;

/**
 * 命令是否触发灾难性操作；返回原因（null = 不触发）。
 * 只对破坏性命令的操作数做目标分类；`sh -c`/`eval` 包裹递归一层。
 */
export function classifyCatastrophicCommand(command: string, depth = 0): string | null {
  if (depth > 2) return null;
  for (const { re, reason } of CATASTROPHIC_COMMAND_PATTERNS) {
    if (re.test(command)) return reason;
  }
  for (const operand of destructiveOperands(command)) {
    const reason = catastrophicTargetReason(operand);
    if (reason) return reason;
  }
  const wrapped = command.match(INLINE_WRAP_RE) ?? command.match(EVAL_WRAP_RE);
  if (wrapped?.[1]) {
    const inner = wrapped[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    return classifyCatastrophicCommand(inner, depth + 1);
  }
  return null;
}

/**
 * 评估一条 bash 命令：提取写入目标 → 逐个按 write 评估；仍有漏网时对
 * 内联执行做字面量兜底。返回第一个非 allow 结论（无目标 = allow）。
 */
export function evaluateBashCommand(
  command: string,
  cwd: string,
  policy: PathPolicy,
  decisions: PolicyDecisions,
  scope?: PathScope | null,
): BashScanResult {
  // 灾难性命令：硬拒绝，不可被 ask/项目策略豁免（自保护清单同地位）。
  const catastrophic = classifyCatastrophicCommand(command);
  if (catastrophic) {
    return {
      // 合成 target：不指向真实路径，避免被"允许一次/持久决策"误匹配。
      target: "!catastrophic",
      verdict: {
        action: "deny",
        reason: `命令触发灾难性操作拦截（${catastrophic}）：无论项目策略如何都不可放行。请改用精确路径，或让用户手动执行。不要重复尝试。`,
      },
    };
  }
  for (const target of extractBashWriteTargets(command, cwd)) {
    const verdict = evaluatePathAgainstPolicy(target, "write", cwd, policy, decisions, scope);
    if (verdict.action !== "allow") return { verdict, target };
  }
  if (bashUsesInlineExecution(command)) {
    const hit = findInlineProtectedPath(command, policy);
    if (hit) {
      return {
        target: hit.path,
        verdict: {
          action: "deny",
          reason: `命令通过内联执行（$()/heredoc/-c/eval）操作受保护路径「${hit.path}」；请改为直接、可审查的命令，或让用户调整 .pi/path-policy.json。不要重复尝试。`,
        },
      };
    }
  }
  return { verdict: { action: "allow" } };
}
