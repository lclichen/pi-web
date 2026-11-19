/**
 * Bounded SFTP channel helper.
 *
 * Every `client.sftp()` costs a session channel; OpenSSH's default
 * `MaxSessions` is 10 per connection. The pool keeps one SSH client per
 * project for reuse, so a channel that is never ended accumulates until the
 * server rejects the next open with:
 *   (SSH) Channel open failure: open failed
 * The file panel (list/read/write) and the SSH agent tools each used to open a
 * channel per operation without closing it. This helper always ends the
 * channel and caps concurrent channels per connection so a burst cannot
 * exhaust the server's limit either.
 */
import type { Client, SFTPWrapper } from "ssh2";

const MAX_CONCURRENT_SFTP = 4;

interface Gate {
  active: number;
  waiters: Array<() => void>;
}

const gates = new WeakMap<object, Gate>();

function gateFor(client: Client): Gate {
  let gate = gates.get(client);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    gates.set(client, gate);
  }
  return gate;
}

async function acquire(client: Client): Promise<() => void> {
  const gate = gateFor(client);
  const release = () => {
    const next = gate.waiters.shift();
    if (next) next(); // hand the slot over without dropping below the cap
    else gate.active -= 1;
  };
  if (gate.active < MAX_CONCURRENT_SFTP) {
    gate.active += 1;
    return release;
  }
  await new Promise<void>((resolve) => gate.waiters.push(resolve));
  return release;
}

/**
 * Translate the SFTP handshake-corruption signature into an actionable error.
 * The SFTP channel's first 4 bytes must be a version-packet length; when the
 * server writes anything first (commonly ~/.ssh/rc, /etc/ssh/sshrc, or a
 * Subsystem sftp wrapper printing a greeting), ssh2 parses those bytes as the
 * length and reports `Packet length ... exceeds max length of 262144`. It does
 * not need to be a long banner: even "AMED" is enough. Nothing on our side can
 * resynchronise that channel — the operator has to remove the output.
 */
export function describeSftpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Packet length .*exceeds max length|SFTP: Inbound/i.test(message)) {
    return "远端 SSH 的 SFTP 通道启动时输出了额外内容（常见于 ~/.ssh/rc、/etc/ssh/sshrc 或 Subsystem sftp 包装脚本），SFTP 无法建立；请移除这些启动输出后重试";
  }
  return message;
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) =>
    client.sftp((err, value) => (err ? reject(new Error(describeSftpError(err))) : resolve(value))),
  );
}

/** Run `fn` on a fresh SFTP channel, always closing it and bounding concurrency.
 *  A hung SFTP operation holds one of the 4 slots forever; four of them starve
 *  every SSH file operation on that connection, so `fn` runs under a timeout
 *  (default 120s, overridable) that releases the slot with an explicit error. */
export async function withSftp<T>(
  client: Client,
  fn: (sftp: SFTPWrapper) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const release = await acquire(client);
  let sftp: SFTPWrapper | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    sftp = await openSftp(client);
    return await Promise.race([
      fn(sftp),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SFTP 操作超时（${timeoutMs}ms）并已释放通道；远端可能已挂起，请稍后重试`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      sftp?.end();
    } catch {
      // channel already closed
    }
    release();
  }
}
