import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Persists the Local Agent's long-lived connection token under the pi agent
// dir with 0o600, mirroring lib/provider-credential-store.ts. The token is the
// single shared secret between the relay and the agent; the browser never sees
// it. Survives pi-web restarts so an already-paired agent can reconnect without
// re-pairing (as long as relay.json is intact).

const WRITE_OPTS = { encoding: "utf-8" as const, mode: 0o600 };

interface RelayFile {
  token: string | null;
  generatedAt: string | null;
}

function relayFilePath(): string {
  return join(getAgentDir(), "relay.json");
}

function ensureFile(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ token: null, generatedAt: null } satisfies RelayFile), WRITE_OPTS);
    chmodSync(path, 0o600);
  }
}

function readRelay(path: string): RelayFile {
  ensureFile(path);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as { token?: unknown; generatedAt?: unknown };
      return {
        token: typeof obj.token === "string" ? obj.token : null,
        generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : null,
      };
    }
  } catch {
    // fall through to empty record
  }
  return { token: null, generatedAt: null };
}

async function writeRelay(path: string, data: RelayFile): Promise<void> {
  ensureFile(path);
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error: Error) => {
      compromised = error;
    },
  });
  try {
    if (compromised) throw compromised;
    writeFileSync(path, JSON.stringify(data, null, 2), WRITE_OPTS);
    chmodSync(path, 0o600);
    if (compromised) throw compromised;
  } finally {
    try {
      await release();
    } catch {
      // ignore unlock errors; the compromised error above is more useful
    }
  }
}

/** Generate a fresh 32-byte agent token, persist it (0o600), and return it. */
export async function issueAgentToken(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeRelay(relayFilePath(), { token, generatedAt: new Date().toISOString() });
  return token;
}

/** Constant-time-ish comparison against the persisted token. */
export function isKnownToken(token: string): boolean {
  if (!token) return false;
  const stored = readRelay(relayFilePath()).token;
  if (!stored || stored.length !== token.length) return false;
  // avoid early-return timing differences
  let diff = 0;
  for (let i = 0; i < stored.length; i++) {
    diff |= stored.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
