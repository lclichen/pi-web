import { execFile } from "child_process";
import { promisify } from "util";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])) || null;
  } catch {
    return null;
  }
}

export async function checkGitAccess(cwd: string): Promise<{ ok: boolean; repoRoot: string | null; error?: string }> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { ok: false, repoRoot: null, error: "Access denied" };
  }
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    return { ok: false, repoRoot: null, error: "Not a git repository" };
  }
  return { ok: true, repoRoot };
}

export interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  message?: string;
  error?: string;
}

export async function gitCommit(
  cwd: string,
  message: string,
  files?: string[],
): Promise<GitCommitResult> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    const repoRoot = access.repoRoot!;

    if (files && files.length > 0) {
      await git(repoRoot, ["add", "--", ...files]);
    } else {
      await git(repoRoot, ["add", "-A"]);
    }

    const staged = await git(repoRoot, ["diff", "--cached", "--name-only"]);
    if (!staged) {
      return { success: false, error: "Nothing to commit (no staged changes)" };
    }

    const result = await git(repoRoot, ["commit", "-m", message]);
    const hashMatch = result.match(/\[([\w/.-]+)\s+([0-9a-f]+)\]/);
    return {
      success: true,
      commitHash: hashMatch?.[2] ?? undefined,
      message: result.split("\n").slice(0, 3).join("\n"),
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function gitStage(cwd: string, files?: string[]): Promise<{ success: boolean; error?: string }> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    const args = files && files.length > 0 ? ["add", "--", ...files] : ["add", "-A"];
    await git(access.repoRoot!, args);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function gitUnstage(cwd: string, files?: string[]): Promise<{ success: boolean; error?: string }> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    const args = files && files.length > 0 ? ["restore", "--staged", "--", ...files] : ["restore", "--staged", "."];
    await git(access.repoRoot!, args);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface GitRemoteResult {
  success: boolean;
  output?: string;
  error?: string;
}

export async function gitPush(cwd: string): Promise<GitRemoteResult> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    const output = await git(access.repoRoot!, ["push"]);
    return { success: true, output: output || "Everything up-to-date" };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function gitPull(cwd: string): Promise<GitRemoteResult> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    const output = await git(access.repoRoot!, ["pull"]);
    return { success: true, output: output || "Already up to date" };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function gitFetch(cwd: string): Promise<GitRemoteResult> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) return { success: false, error: access.error };

  try {
    await git(access.repoRoot!, ["fetch", "--all"]);
    return { success: true, output: "Fetch complete" };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface GitBranchInfo {
  current: string | null;
  ahead: number;
  behind: number;
  tracking: string | null;
  all: string[];
}

export async function getGitBranchInfo(cwd: string): Promise<GitBranchInfo> {
  const access = await checkGitAccess(cwd);
  if (!access.ok) {
    return { current: null, ahead: 0, behind: 0, tracking: null, all: [] };
  }

  try {
    const repoRoot = access.repoRoot!;
    let current: string | null = null;
    try {
      current = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
      if (current === "HEAD") current = null;
    } catch { /* detached HEAD */ }

    const rawBranches = await git(repoRoot, ["branch", "--list", "--format=%(refname:short)"]);
    const all = rawBranches.split("\n").map((b) => b.trim()).filter(Boolean);

    let ahead = 0;
    let behind = 0;
    let tracking: string | null = null;

    if (current) {
      try {
        const trackingRaw = await git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        tracking = trackingRaw || null;
      } catch { /* no upstream */ }

      if (tracking) {
        try {
          const counts = await git(repoRoot, ["rev-list", "--left-right", "--count", `${tracking}...HEAD`]);
          const parts = counts.split(/\s+/).filter(Boolean);
          behind = parseInt(parts[0] ?? "0", 10) || 0;
          ahead = parseInt(parts[1] ?? "0", 10) || 0;
        } catch { /* counts failed */ }
      }
    }

    return { current, ahead, behind, tracking, all };
  } catch {
    return { current: null, ahead: 0, behind: 0, tracking: null, all: [] };
  }
}
