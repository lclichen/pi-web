/**
 * SSH project support — config storage and a per-project connection pool.
 *
 * Credentials live in the project home at .pi/ssh.json (mode 0600), mirroring
 * how sandbox credentials sit in sandbox-platform.json. They never travel in
 * config bundles (exportProjectConfigBundle strips auth.json only, so the
 * dedicated filename + explicit deny keep this file out of shared bundles —
 * see DENIED_BASENAMES in project-config-bundle.ts).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "ssh2";

export interface SshConfigInput {
  host: string;
  port?: number;
  username: string;
  /** 认证方式：密码或私钥（二选一；都缺省时尝试服务器 ~/.ssh 默认密钥）。 */
  authType?: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshConfig extends SshConfigInput {
  port: number;
}

const CONFIG_FILE = "ssh.json";

export function writeSshConfig(home: string, config: SshConfigInput): void {
  const dir = join(home, ".pi");
  if (!existsSync(dir)) mkdirSyncMode(dir);
  const full: SshConfig = { ...config, port: config.port ?? 22 };
  const target = join(dir, CONFIG_FILE);
  writeFileSync(target, JSON.stringify(full, null, 2), { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch { /* best effort on fs without chmod */ }
}

export function readSshConfig(home: string): SshConfig | null {
  const target = join(home, ".pi", CONFIG_FILE);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as SshConfigInput;
    return { ...parsed, port: parsed.port ?? 22 };
  } catch {
    return null;
  }
}

function mkdirSyncMode(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Connection pool — one cached Client per project, reused across tool calls
// within the process; a dead connection is transparently re-established.
// ---------------------------------------------------------------------------

// Lazy require keeps ssh2 out of the Next.js module graph for builds that
// never touch SSH mode, and tolerates the package's optional native bindings.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ssh2 = (): typeof import("ssh2") => require("ssh2") as typeof import("ssh2");

interface PoolEntry {
  client: Client;
  connecting: Promise<Client> | null;
}

const pool = new Map<string, PoolEntry>();

function connectClient(config: SshConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new (ssh2().Client)();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH 连接超时：${config.host}:${config.port}`));
    }, 15_000);
    client
      .on("ready", () => {
        clearTimeout(timer);
        resolve(client);
      })
      .on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`SSH 连接失败：${err.message}`));
      })
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        ...(config.authType === "password" && config.password
          ? { password: config.password }
          : config.privateKey
            ? { privateKey: config.privateKey, ...(config.passphrase ? { passphrase: config.passphrase } : {}) }
            : {}),
        readyTimeout: 15_000,
      });
  });
}

/** Get (or re-establish) the pooled SSH connection for a project. */
export async function getSshClient(projectId: string, config: SshConfig): Promise<Client> {
  const entry = pool.get(projectId);
  if (entry?.connecting) return entry.connecting;
  if (entry) {
    const alive = await new Promise<boolean>((resolve) => {
      try {
        entry!.client.exec("true", (err) => resolve(!err));
      } catch {
        resolve(false);
      }
    });
    if (alive) return entry.client;
    pool.delete(projectId);
  }
  const fresh: PoolEntry = { client: new (ssh2().Client)(), connecting: null };
  const connecting = connectClient(config).then((client) => {
    fresh.client = client;
    fresh.connecting = null;
    return client;
  }).catch((err) => {
    pool.delete(projectId);
    fresh.connecting = null;
    throw err;
  });
  fresh.connecting = connecting;
  pool.set(projectId, fresh);
  return connecting;
}

/** Drop a project's cached connection (project deletion / config change). */
export function dropSshClient(projectId: string): void {
  const entry = pool.get(projectId);
  if (entry) {
    try { entry.client.end(); } catch { /* already dead */ }
    pool.delete(projectId);
  }
}

/**
 * One-shot connection check for the wizard's 「测试连接」 button: opens a fresh
 * client with the *given* credentials and closes it. Deliberately not pooled —
 * a pooled key of user/host/port would hand back an already-authenticated
 * connection and "validate" credentials that were never tried.
 */
export async function sshTestConnection(config: SshConfig): Promise<{ whoami: string }> {
  const client = await connectClient(config);
  try {
    const whoami = await new Promise<string>((resolve, reject) => {
      client.exec("whoami", (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.on("close", () => resolve(out.trim()));
      });
    });
    return { whoami };
  } finally {
    try { client.end(); } catch { /* already dead */ }
  }
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command in `cwd` on the remote host (best-effort cd; failures surface via stderr). */
export function sshExec(
  client: Client,
  command: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const quotedCwd = `'${cwd.replace(/'/g, `'\\''`)}'`;
    client.exec(`cd ${quotedCwd} 2>/dev/null || cd /; { ${command}\n; }`, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
      }, timeoutMs);
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      stream.on("close", (code?: number) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
  });
}
