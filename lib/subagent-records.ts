import { createReadStream } from "fs";
import { createInterface } from "readline";
import { listAllSessions } from "./session-reader";
import type { SubagentRecord } from "./subagent-shared";

export type { SubagentRecord } from "./subagent-shared";
export { formatRelativeTime } from "./subagent-shared";

/**
 * Subagent history for one parent session, read from two places:
 *
 * 1. `subagents:record` custom entries the pi-subagents plugin appends to the
 *    parent session file when each top-level agent settles. They carry
 *    absolute start/end timestamps — the source for "3 分钟前" style labels.
 * 2. The session list (SDK SessionManager.listAll): subagent sessions are
 *    real pi sessions named "<Type>#<agentId>" with the parent session as
 *    their parent, so they can be opened and replayed like any session.
 */

export interface SubagentDirectoryData {
  records: SubagentRecord[];
  /** agentId -> session id of the persisted subagent conversation, if any. */
  sessions: Record<string, string>;
}

interface RecordEntry {
  type: "custom";
  customType?: string;
  data?: {
    id?: unknown;
    type?: unknown;
    description?: unknown;
    status?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

/** Scan one session JSONL for the newest subagents:record entry per agent. */
export async function readSubagentRecords(sessionFilePath: string): Promise<SubagentRecord[]> {
  const byId = new Map<string, SubagentRecord>();
  try {
    const rl = createInterface({
      input: createReadStream(sessionFilePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes("subagents:record")) continue; // cheap pre-filter
      let entry: RecordEntry;
      try {
        entry = JSON.parse(line) as RecordEntry;
      } catch {
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== "subagents:record") continue;
      const d = entry.data ?? {};
      if (typeof d.id !== "string") continue;
      byId.set(d.id, {
        id: d.id,
        type: typeof d.type === "string" ? d.type : "agent",
        description: typeof d.description === "string" ? d.description : "",
        status: typeof d.status === "string" ? d.status : "completed",
        ...(typeof d.startedAt === "number" ? { startedAt: d.startedAt } : {}),
        ...(typeof d.completedAt === "number" ? { completedAt: d.completedAt } : {}),
        ...(typeof d.result === "string" ? { result: d.result } : {}),
        ...(typeof d.error === "string" ? { error: d.error } : {}),
      });
    }
  } catch {
    // unreadable/missing file — no history
  }
  return [...byId.values()];
}

/**
 * Find persisted subagent conversations: sessions named "<Type>#<agentId8+>"
 * are matched by the "#id" suffix so the record's full agentId links to its
 * session without trusting the type prefix.
 */
export async function findSubagentSessions(
  parentSessionId: string,
  records: SubagentRecord[],
): Promise<Record<string, string>> {
  const sessions: Record<string, string> = {};
  if (records.length === 0) return sessions;
  const all = await listAllSessions();
  const idEnds = new Map<string, string>(); // "#<suffix>" -> sessionId
  for (const s of all) {
    const name = s.name;
    if (!name) continue;
    const hash = name.lastIndexOf("#");
    if (hash < 0) continue;
    idEnds.set(name.slice(hash + 1), s.id);
  }
  for (const record of records) {
    // Session names use an id slice; match longest-first so a full id wins
    // over a shorter prefix collision.
    for (let len = record.id.length; len >= 6; len--) {
      const hit = idEnds.get(record.id.slice(0, len));
      if (hit !== undefined && hit !== parentSessionId) {
        sessions[record.id] = hit;
        break;
      }
    }
  }
  return sessions;
}
