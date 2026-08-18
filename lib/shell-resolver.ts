import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Shell resolution for the local workspace terminal (Part A of the terminal
 * feature). The terminal runs a PTY on the pi-web server host itself, so the
 * shell candidates are whatever that host has installed.
 *
 * Priority: an explicit request (dropdown) > PI_WEB_TERMINAL_SHELL env >
 * auto-detection. On Windows the detection mirrors the pi SDK's bash tool
 * (Git Bash first, so behavior matches `!command` and the agent's bash tool),
 * then PowerShell, then cmd. On POSIX it's $SHELL, then /bin/bash.
 */

export interface ShellInfo {
  /** Stable id used in API calls ("pwsh" is normalized for both editions). */
  id: string;
  /** Label for the dropdown. */
  label: string;
  /** Absolute executable path. */
  path: string;
}

const isWindows = process.platform === "win32";

function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function detectPowerShell(): string | null {
  // pwsh (PowerShell 7+) anywhere on PATH beats the Windows-builtin edition.
  const pwsh = findOnPath(isWindows ? "pwsh.exe" : "pwsh");
  if (pwsh) return pwsh;
  if (isWindows) {
    const paths = [
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ];
    for (const p of paths) if (exists(p)) return p;
  }
  return null;
}

function detectGitBash(): string | null {
  if (!isWindows) return null;
  // Same locations the pi SDK's shell locator probes (utils/shell.js).
  const candidates: string[] = [];
  for (const envVar of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const root = process.env[envVar];
    if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) candidates.push(join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  for (const c of candidates) if (exists(c)) return c;
  return findOnPath("bash.exe");
}

function findOnPath(exe: string): string | null {
  const pathExt = isWindows ? (process.env.PATHEXT ?? ".exe") : "";
  const dirs = (process.env.PATH ?? "").split(isWindows ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    const direct = join(dir, exe);
    if (exists(direct)) return direct;
    for (const ext of pathExt.split(";")) {
      if (!ext || ext === ".COM") continue;
      const withExt = join(dir, exe.replace(/\.exe$/i, "") + ext);
      if (exists(withExt)) return withExt;
    }
  }
  return null;
}

function detectPosixShell(): string | null {
  const shell = process.env.SHELL;
  if (shell && exists(shell)) return shell;
  if (exists("/bin/bash")) return "/bin/bash";
  if (exists("/bin/sh")) return "/bin/sh";
  return null;
}

/** All shells we can offer in the dropdown, best first. */
export function listShells(): ShellInfo[] {
  const out: ShellInfo[] = [];
  if (isWindows) {
    const bash = detectGitBash();
    if (bash) out.push({ id: "bash", label: "Git Bash", path: bash });
    const pwsh = detectPowerShell();
    if (pwsh) {
      out.push({
        id: "pwsh",
        label: pwsh.toLowerCase().includes("windowspowershell") ? "Windows PowerShell" : "PowerShell",
        path: pwsh,
      });
    }
    const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    if (exists(cmd)) out.push({ id: "cmd", label: "命令提示符", path: cmd });
  } else {
    const shell = detectPosixShell();
    if (shell) out.push({ id: "shell", label: shell, path: shell });
    const zsh = findOnPath("zsh");
    if (zsh) out.push({ id: "zsh", label: "zsh", path: zsh });
    if (exists("/bin/bash") && !out.some((s) => s.path === "/bin/bash")) {
      out.push({ id: "bash", label: "bash", path: "/bin/bash" });
    }
  }
  return out;
}

/**
 * Resolve the shell to spawn: an explicit `pref` (id or path from the
 * dropdown), else PI_WEB_TERMINAL_SHELL, else the first detected entry.
 * Throws with a readable message when nothing is available.
 */
export function resolveShell(pref?: string): ShellInfo {
  const shells = listShells();
  if (pref) {
    const hit =
      shells.find((s) => s.id === pref) ||
      shells.find((s) => s.path === pref);
    if (hit) return hit;
    // An unknown explicit preference is honored if it points at a real file —
    // lets users set PI_WEB_TERMINAL_SHELL to anything without code changes.
    if (exists(pref)) return { id: "custom", label: pref, path: pref };
    throw new Error(`Shell not found: ${pref}`);
  }
  const envShell = process.env.PI_WEB_TERMINAL_SHELL;
  if (envShell) {
    const hit = shells.find((s) => s.id === envShell || s.path === envShell);
    if (hit) return hit;
    if (exists(envShell)) return { id: "custom", label: envShell, path: envShell };
    throw new Error(`PI_WEB_TERMINAL_SHELL points at a missing shell: ${envShell}`);
  }
  const first = shells[0];
  if (!first) throw new Error("No shell found on this host");
  return first;
}
