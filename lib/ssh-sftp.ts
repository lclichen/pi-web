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

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, value) => (err ? reject(err) : resolve(value))));
}

/** Run `fn` on a fresh SFTP channel, always closing it and bounding concurrency. */
export async function withSftp<T>(client: Client, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const release = await acquire(client);
  let sftp: SFTPWrapper | undefined;
  try {
    sftp = await openSftp(client);
    return await fn(sftp);
  } finally {
    try {
      sftp?.end();
    } catch {
      // channel already closed
    }
    release();
  }
}
