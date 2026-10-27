import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Server-side skill read bridge (local-machine relay + SSH modes).
 *
 * Design contract: agent runtime config (skills, extensions, subagents, MCP,
 * policy) lives on the pi-web SERVER. The SDK session — which also runs on
 * the server — discovers skills from the session homes (<home>/.pi/skills,
 * project scope) and the server agent dir (~/.pi/agent/skills unless
 * PI_CODING_AGENT_DIR overrides it) and lists them in the system prompt.
 * Those files do NOT exist on the user's machine or the SSH host, so read/ls
 * of any skills-shaped path is served from the server instead of being
 * relayed — regardless of the prefix the model used:
 *
 *   ~/.pi/agent/skills/<name>/SKILL.md         (exactly as listed in the prompt)
 *   /home/<anyone>/.pi/agent/skills/<name>/... (model-expanded ~, any host)
 *   .pi/skills/<name>/SKILL.md                 (session-home relative)
 *
 * The prefix is irrelevant by design; if a client workspace happens to carry
 * a .pi/skills copy it is inert — the server-side copy is authoritative.
 * The workspace fence on the agent client stays strict (strong isolation);
 * this bridge keeps skill reads from ever hitting it.
 */

const MARKERS = [".pi/agent/skills", ".pi/skills"] as const;
export type SkillMarker = (typeof MARKERS)[number];

export interface SkillBridgeOptions {
  /** Session-scope homes in priority order (project home, then the call's cwd). */
  homes?: Array<string | undefined | null>;
  /** SDK user-scope agent dir (getAgentDir()); defaults to ~/.pi/agent. */
  agentDir?: string;
}

export interface SkillBridgeMatch {
  /** Absolute server-side path to serve the read/ls from. */
  path: string;
  /** Which skills tree the path belongs to. */
  marker: SkillMarker;
}

function isSafeTail(tail: string): boolean {
  if (tail === "") return true;
  if (tail.startsWith("/")) return false;
  return tail.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Map a tool-call path to the server-side skills file it refers to, or null
 * when the path is not skills-shaped (relay it normally). Candidates resolve
 * by existence; when none exists the first candidate is returned so the read
 * fails server-side with a clear path instead of leaking to the client.
 */
export function matchServerSkillPath(raw: string, options: SkillBridgeOptions = {}): SkillBridgeMatch | null {
  const homes = (options.homes ?? [])
    .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.replace(/[\\/]+$/, ""));
  const agentDir = (options.agentDir ?? join(homedir(), ".pi", "agent")).replace(/[\\/]+$/, "");
  const cleaned = String(raw ?? "")
    .replace(/^@/, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "/") return null;
  // A literal ~/~user prefix names the CLIENT's home — irrelevant by design.
  const unhome = cleaned.startsWith("~") ? cleaned.replace(/^~[^/]*\/?/, "") : cleaned;
  if (!unhome) return null;

  for (const marker of MARKERS) {
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
    if (marker === ".pi/agent/skills") {
      roots = [...homes.map((h) => join(h, marker)), join(agentDir, "skills")];
      canonical = join(join(agentDir, "skills"), tail);
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
