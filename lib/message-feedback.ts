/**
 * Message-level feedback (👍/👎) — client side.
 *
 * The transport is deliberately optional: the buttons work fully offline
 * (localStorage) and TRY to deliver to the AI gateway. Until the gateway
 * ships its endpoint, every submission is kept locally and re-delivered on
 * the next attempt (see docs/dev/feedback-api.md for the contract this
 * client expects).
 */

export type FeedbackValue = "up" | "down";

export interface FeedbackRecord {
  sessionId: string;
  entryId: string;
  value: FeedbackValue;
  /** Preview snippet for the outbox UI/debugging (first 200 chars). */
  snippet: string;
  createdAt: number;
}

const STORAGE_KEY = "pi-web:message-feedback";
/** Endpoint the AI gateway will expose (see docs/dev/feedback-api.md). */
const FEEDBACK_ENDPOINT = "/api/feedback";
/** Outbox cap — oldest entries drop first. */
const MAX_OUTBOX = 500;

interface FeedbackStore {
  /** sessionId:entryId → record (latest verdict wins). */
  marks: Record<string, FeedbackRecord>;
  /** Unsent submissions, oldest first. */
  outbox: FeedbackRecord[];
}

function loadStore(): FeedbackStore {
  if (typeof window === "undefined") return { marks: {}, outbox: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { marks: {}, outbox: [] };
    const parsed = JSON.parse(raw) as Partial<FeedbackStore>;
    return { marks: parsed.marks ?? {}, outbox: parsed.outbox ?? [] };
  } catch {
    return { marks: {}, outbox: [] };
  }
}

function saveStore(store: FeedbackStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full/blocked — feedback is best-effort, never fatal.
  }
}

function keyOf(sessionId: string, entryId: string): string {
  return `${sessionId}:${entryId}`;
}

/** Current verdict for a message, if any. */
export function getFeedback(sessionId: string, entryId: string): FeedbackValue | null {
  return loadStore().marks[keyOf(sessionId, entryId)]?.value ?? null;
}

/**
 * Record (or clear with value=null) a verdict. The mark persists locally;
 * delivery is attempted immediately and the record stays in the outbox until
 * the gateway acknowledges it.
 */
export function setFeedback(
  sessionId: string,
  entryId: string,
  value: FeedbackValue | null,
  snippet = "",
): void {
  const store = loadStore();
  const key = keyOf(sessionId, entryId);
  if (value === null) {
    delete store.marks[key];
    store.outbox = store.outbox.filter((r) => keyOf(r.sessionId, r.entryId) !== key);
    saveStore(store);
    return;
  }
  const record: FeedbackRecord = { sessionId, entryId, value, snippet: snippet.slice(0, 200), createdAt: Date.now() };
  store.marks[key] = record;
  store.outbox.push(record);
  if (store.outbox.length > MAX_OUTBOX) store.outbox = store.outbox.slice(-MAX_OUTBOX);
  saveStore(store);
  void flushFeedback();
}

let flushing = false;

/**
 * Try to deliver the outbox. Failures are silent by design: the endpoint may
 * not exist yet (404/405), and the outbox retries on the next verdict.
 * Returns the number of records successfully delivered.
 */
export async function flushFeedback(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const store = loadStore();
  if (store.outbox.length === 0 || flushing) return 0;
  flushing = true;
  let delivered = 0;
  try {
    while (store.outbox.length > 0) {
      const batch = store.outbox.slice(0, 50);
      try {
        const res = await fetch(FEEDBACK_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback: batch }),
        });
        if (!res.ok) break; // gateway absent or rejected — keep the outbox
        const data = (await res.json().catch(() => ({}))) as { accepted?: string[] };
        const acked = new Set(data.accepted ?? batch.map((r) => keyOf(r.sessionId, r.entryId)));
        store.outbox = store.outbox.filter((r) => !acked.has(keyOf(r.sessionId, r.entryId)));
        delivered += acked.size;
        saveStore(store);
        if ((data.accepted ?? []).length === 0) break; // nothing acked — stop
      } catch {
        break; // network down — retry next time
      }
    }
  } finally {
    flushing = false;
  }
  return delivered;
}
