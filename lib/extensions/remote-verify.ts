import { join, relative, resolve } from "path";
import { readFileSync } from "fs";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { relayRpc } from "@/lib/relay/forward";

/**
 * Remote-verify bridge for embedded web sessions (design: 两目录模型).
 *
 * pi-lab-training's verification must run where the workspace REALLY lives —
 * the sandbox container or the user's paired machine — not on the pi-web
 * server next to the project home (config directory). Extensions cannot
 * invoke the session's tools through the official extension API, so pi-web
 * injects this bridge as an inline extension and publishes per-session ops
 * on globalThis, keyed by lowercased session cwd. pi-lab-training picks them
 * up via createBridgeOps(cwd); absent in CLI usage.
 */

interface BridgeOps {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  execCommand(command: string, cwd?: string): Promise<{ stdout: string }>;
}

declare global {
  var __piWebRemoteVerify: Map<string, BridgeOps> | undefined;
}

function registry(): Map<string, BridgeOps> {
  globalThis.__piWebRemoteVerify ??= new Map();
  return globalThis.__piWebRemoteVerify;
}

/** Host-absolute path → workspace-relative (POSIX separators). Throws when
 *  the path escapes the project home — verify targets must live in the
 *  workspace that mirrors the home. */
function toRelative(sessionCwd: string, target: string): string {
  const rel = relative(resolve(sessionCwd), resolve(target)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`验证路径不在项目工作区内: ${target}`);
  }
  return rel;
}

/** Container ops: platform tools API against the project's bound container
 *  (the same .pi/sandbox-platform.json the sandbox extension reads). */
function sandboxOps(sessionCwd: string): BridgeOps | null {
  let url: string;
  let apiKey: string;
  let containerId: number;
  try {
    const cfg = JSON.parse(
      readFileSync(join(sessionCwd, ".pi", "sandbox-platform.json"), "utf8"),
    ) as { url?: string; apiKey?: string; containerId?: number | string };
    if (!cfg.url || !cfg.apiKey || !cfg.containerId) return null;
    url = cfg.url.replace(/\/+$/, "");
    apiKey = cfg.apiKey;
    containerId = Number(cfg.containerId);
  } catch {
    return null;
  }
  const base = `${url}/api/v1/containers/${containerId}/tools`;
  const headers = { "Content-Type": "application/json", "X-API-Key": apiKey };

  const bash = async (command: string, cwd?: string) => {
    const res = await fetch(`${base}/bash`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: cwd ? `cd ${shellQ(cwd)} && ${command}` : command,
        timeout: 30,
      }),
      cache: "no-store",
    });
    const body = (await res.json()) as { stdout?: string; stderr?: string; exitCode?: number };
    if (!res.ok) throw new Error(`容器执行失败 (HTTP ${res.status})`);
    if (body.exitCode !== 0) throw new Error(`命令退出码 ${body.exitCode}: ${body.stderr ?? ""}`);
    return { stdout: body.stdout ?? "" };
  };

  return {
    fileExists: async (path) => {
      const rel = toRelative(sessionCwd, path);
      try {
        const res = await fetch(`${base}/access?path=${encodeURIComponent("/workspace/" + rel)}`, {
          headers: { "X-API-Key": apiKey },
          cache: "no-store",
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { exists?: boolean };
        return Boolean(body.exists);
      } catch {
        return false;
      }
    },
    readFile: async (path) => {
      const rel = toRelative(sessionCwd, path);
      const res = await fetch(`${base}/read`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "/workspace/" + rel }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`容器读取失败 (HTTP ${res.status}): ${rel}`);
      const body = (await res.json()) as { contentBase64?: string };
      return Buffer.from(body.contentBase64 ?? "", "base64").toString("utf8");
    },
    execCommand: async (command, cwd) => {
      const remoteCwd = cwd ? "/workspace/" + toRelative(sessionCwd, cwd) : undefined;
      return bash(command, remoteCwd);
    },
  };
}

/** Relay ops: the user's paired machine (workspace-relative fs + exec). */
function relayOps(userId: number, sessionCwd: string): BridgeOps {
  const call = <T>(method: string, params: Record<string, unknown>) =>
    relayRpc(method, params, { userId }) as Promise<T>;
  return {
    fileExists: async (path) => {
      try {
        await call("fs.stat", { path: toRelative(sessionCwd, path) });
        return true;
      } catch {
        return false;
      }
    },
    readFile: async (path) => {
      const r = await call<{ content: string }>("fs.read", { path: toRelative(sessionCwd, path) });
      return r.content;
    },
    execCommand: async (command, cwd) => {
      const r = await call<{ stdout: string; exitCode: number; stderr?: string }>("exec.run", {
        argv: ["bash", "-c", command],
        ...(cwd ? { cwd: toRelative(sessionCwd, cwd) } : {}),
        timeout: 30_000,
      });
      if (r.exitCode !== 0) throw new Error(`命令退出码 ${r.exitCode}: ${r.stderr ?? ""}`);
      return { stdout: r.stdout ?? "" };
    },
  };
}

function shellQ(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Inline extension publishing the bridge for this session. Injected by
 * /api/agent/new alongside the mode's tool extension.
 */
export function makeRemoteVerifyExtension(
  kind: "sandbox" | "local-machine",
  userId: number,
): InlineExtension {
  return (pi: ExtensionAPI): void => {
    let key: string | undefined;
    pi.on("session_start", async (_event, ctx) => {
      key = resolve(ctx.cwd).toLowerCase();
      const ops = kind === "sandbox" ? sandboxOps(ctx.cwd) : relayOps(userId, ctx.cwd);
      if (ops) registry().set(key, ops);
    });
    pi.on("session_shutdown", async () => {
      if (key) registry().delete(key);
    });
  };
}
