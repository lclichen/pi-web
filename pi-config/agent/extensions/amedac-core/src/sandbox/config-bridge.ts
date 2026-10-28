/**
 * Runtime-config read bridge for the sandbox tools (container mode).
 *
 * Design contract (mirrors pi-web lib/relay/runtime-config-bridge.ts — keep
 * the two matchers behaviorally identical; this copy exists because
 * amedac-core is a zero-dependency package shipped to the CLI too): agent
 * runtime config (skills, subagent definitions) lives on the EXTENSION HOST
 * (the machine running pi — the pi-web server in embedded mode). The SDK
 * discovers skills/agents from <cwd>/.pi/skills|.pi/agents (project) and
 * getAgentDir()/skills|agents (user scope) and lists them in the system
 * prompt. Those files are never synced into the container (.pi is in the
 * sync ignore list), so read/ls of any config-shaped path is served from the
 * host instead of being routed into the container — regardless of the
 * prefix the model used:
 *
 *   ~/.pi/agent/skills/<name>/SKILL.md         (as listed in the prompt)
 *   /root/.pi/agent/skills/<name>/SKILL.md     (model-expanded ~ IN the container)
 *   .pi/agents/<name>.md                       (project-relative)
 *
 * The prefix is irrelevant by design: a container-side .pi copy cannot exist
 * (sync ignores it), so the host copy is always authoritative. READ-ONLY:
 * writes to these shapes route into the container normally and fail there —
 * the server store can never be mutated from a container session.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

function isSafeTail(tail: string): boolean {
  if (tail === "") return true;
  if (tail.startsWith("/")) return false;
  return tail.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Map a tool-call path to the HOST-side runtime-config file it refers to, or
 * null when the path is not config-shaped (route it into the container).
 * Candidates resolve by existence; when none exists the canonical discovery
 * location is returned so the read fails on the host with a clear path
 * instead of a confusing container miss.
 */
export function matchRuntimeConfigFile(
  raw: string,
  homes: Array<string | undefined | null>,
  agentDir = getAgentDir(),
): string | null {
  const roots = homes
    .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.replace(/[\\/]+$/, ""));
  const cleaned = String(raw ?? "")
    .replace(/^@/, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "/") return null;
  // A literal ~/~user prefix names whichever home the model expanded against
  // (container root, host user) — irrelevant by design.
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
    let candidates: string[];
    let canonical: string;
    if (userDir) {
      candidates = [...roots.map((h) => join(h, marker)), join(agentDir, userDir)];
      canonical = join(join(agentDir, userDir), tail);
    } else {
      candidates = roots.map((h) => join(h, marker));
      if (candidates.length === 0) continue;
      canonical = join(candidates[0], tail);
    }
    const targets = tail ? candidates.map((c) => join(c, tail)) : candidates;
    return targets.find((t) => existsSync(t)) ?? canonical;
  }
  return null;
}

/**
 * Session gate: the sandbox tools activate only where sandbox config exists.
 * pi-web writes <home>/.pi/sandbox-platform.json for every sandbox session
 * home; CLI projects opt in the same way. The SANDBOX_* env pair keeps the
 * legacy env-driven CLI flow working. The GLOBAL config file is deliberately
 * NOT consulted — on a pi-web server it would light the module up for every
 * non-sandbox session in the process.
 */
export function sandboxConfigPresent(cwd: string): boolean {
  if (process.env.SANDBOX_PLATFORM_URL || process.env.SANDBOX_CONTAINER) return true;
  try {
    return existsSync(join(cwd, ".pi", "sandbox-platform.json"));
  } catch {
    return false;
  }
}
