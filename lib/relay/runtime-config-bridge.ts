import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Server-side runtime-config read bridge (local-machine relay + SSH modes).
 *
 * Design contract: agent runtime config (skills, subagent definitions,
 * extensions, MCP, policy) lives on the pi-web SERVER. The SDK session —
 * which also runs on the server — discovers skills and subagents from the
 * session homes (<home>/.pi/skills, <home>/.pi/agents, project scope) and
 * the server agent dir (getAgentDir()/skills|agents — ~/.pi/agent unless
 * PI_CODING_AGENT_DIR overrides it) and lists them in the system prompt.
 * Those files do NOT exist on the user's machine or the SSH host, so
 * read/ls of any config-shaped path is served from the server instead of
 * being relayed — regardless of the prefix the model used:
 *
 *   ~/.pi/agent/skills/<name>/SKILL.md         (exactly as listed in the prompt)
 *   /home/<anyone>/.pi/agent/skills/<name>/... (model-expanded ~, any host)
 *   .pi/agents/<name>.md                       (session-home relative)
 *
 * The prefix is irrelevant by design; if a client workspace happens to carry
 * a .pi/skills or .pi/agents copy (e.g. a repo checked out with its config),
 * it is inert — the server-side copy is authoritative. The bridge is
 * READ-ONLY: writes to these shapes relay normally, so the client-side
 * workspace fence (strong isolation) stays the only writer gate and the
 * server store can never be mutated from a client-mode session.
 */

interface MarkerDef {
  /** Path marker (POSIX, segment-aligned) identifying the config tree. */
  marker: string;
  /** Present for user-scope trees: subdirectory of getAgentDir(). */
  userDir?: string;
}

const MARKERS: readonly MarkerDef[] = [
  { marker: ".pi/agent/skills", userDir: "skills" },
  { marker: ".pi/agent/agents", userDir: "agents" },
  { marker: ".pi/skills" },
  { marker: ".pi/agents" },
];

export interface RuntimeConfigBridgeOptions {
  /** Session-scope homes in priority order (project home, then the call's cwd). */
  homes?: Array<string | undefined | null>;
  /** SDK user-scope agent dir (getAgentDir()); overridable for tests. */
  agentDir?: string;
}

export interface RuntimeConfigBridgeMatch {
  /** Absolute server-side path to serve the read/ls from. */
  path: string;
  /** Which config tree the path belongs to. */
  marker: string;
}

function isSafeTail(tail: string): boolean {
  if (tail === "") return true;
  if (tail.startsWith("/")) return false;
  return tail.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Map a tool-call path to the server-side runtime-config file it refers to,
 * or null when the path is not config-shaped (relay it normally). Candidates
 * resolve by existence; when none exists the canonical location is returned
 * so the read fails server-side with a clear path instead of leaking to the
 * client.
 */
export function matchRuntimeConfigPath(raw: string, options: RuntimeConfigBridgeOptions = {}): RuntimeConfigBridgeMatch | null {
  const homes = (options.homes ?? [])
    .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.replace(/[\\/]+$/, ""));
  const agentDir = (options.agentDir ?? getAgentDir()).replace(/[\\/]+$/, "");
  const cleaned = String(raw ?? "")
    .replace(/^@/, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "/") return null;
  // A literal ~/~user prefix names the CLIENT's home — irrelevant by design.
  const unhome = cleaned.startsWith("~") ? cleaned.replace(/^~[^/]*\/?/, "") : cleaned;
  if (!unhome) return null;

  for (const { marker, userDir } of MARKERS) {
    let tail: string;
    if (unhome === marker || unhome.startsWith(`${marker}/`)) {
      tail = unhome.slice(marker.length).replace(/^\/+/, "");
    } else {
      const withSlash = `/${marker}/`;
      const idx = unhome.indexOf(withSlash);
      if (idx !== -1) tail = unhome.slice(idx + withSlash.length);
      else if (unhome.endsWith(`/${marker}`)) tail = "";
      else continue;
    }
    if (!isSafeTail(tail)) continue;
    let roots: string[];
    // Canonical location the SDK discovery would list this file from — used
    // as the fallback so a missing file errors on the path the prompt named.
    let canonical: string;
    if (userDir) {
      roots = [...homes.map((h) => join(h, marker)), join(agentDir, userDir)];
      canonical = join(join(agentDir, userDir), tail);
    } else {
      roots = homes.map((h) => join(h, marker));
      if (roots.length === 0) continue;
      canonical = join(roots[0], tail);
    }
    const targets = tail ? roots.map((r) => join(r, tail)) : roots;
    const hit = targets.find((t) => existsSync(t)) ?? canonical;
    return { path: hit, marker };
  }
  return null;
}
