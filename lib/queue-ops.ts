/**
 * Pure queue-op transformation for the update_queue agent command.
 *
 * pi's SDK has no single-item dequeue: the only primitives are steer()/
 * followUp() (enqueue) and clearQueue() (drain all, returns texts). Single-
 * item edit/delete/convert/interrupt are therefore computed here as a pure
 * array transformation — the caller drains the live queue, applies one op,
 * and requeues the result within a single microtask chain (atomic w.r.t. the
 * agent loop, which only runs on I/O macrotasks).
 *
 * Image caveat: clearQueue() returns texts only — image attachments on
 * queued messages do not survive a drain+requeue cycle. applyQueueOp takes
 * an isImageProtected predicate and rejects any op that would rebuild (or
 * re-send) a protected message without its image. Deleting the protected
 * message itself is allowed: the image is dropped together with the message,
 * which is the requested outcome.
 */
export type QueueKind = "steering" | "followUp";

export interface QueueOpEdit {
  op: "edit";
  kind: QueueKind;
  index: number;
  text: string;
}
export interface QueueOpDelete {
  op: "delete";
  kind: QueueKind;
  index: number;
}
/** steering ↔ followUp; the message moves to the end of the other list. */
export interface QueueOpConvert {
  op: "convert";
  kind: QueueKind;
  index: number;
}
/**
 * Abort the current run and send this message as a fresh turn immediately.
 * Remaining messages are requeued first so they inject into the new run.
 */
export interface QueueOpInterrupt {
  op: "interrupt";
  kind: QueueKind;
  index: number;
}

export type QueueOp = QueueOpEdit | QueueOpDelete | QueueOpConvert | QueueOpInterrupt;

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export type QueueOpError =
  | "index_out_of_bounds"
  | "empty_text"
  | "image_protected";

export type QueueOpResult =
  | {
      ok: true;
      /** The queue state to requeue. */
      next: QueueState;
      /** Set for interrupt: send this text as a fresh turn after aborting. */
      interruptedText?: string;
    }
  | { ok: false; error: QueueOpError };

function listFor(state: QueueState, kind: QueueKind): string[] {
  return kind === "steering" ? state.steering : state.followUp;
}

/**
 * True when every message that survives the rebuild (and, for interrupt,
 * the message being re-sent) is image-free, so drain+requeue loses nothing.
 */
function rebuildIsSafe(
  state: QueueState,
  kind: QueueKind,
  dropIndex: number,
  isImageProtected: (text: string) => boolean,
  /** Messages re-added to the rebuild after transformation (edit/convert). */
  reAdded?: string,
): boolean {
  const list = listFor(state, kind);
  for (let i = 0; i < list.length; i++) {
    if (i === dropIndex) continue;
    if (isImageProtected(list[i]!)) return false;
  }
  const other = listFor(state, kind === "steering" ? "followUp" : "steering");
  for (const text of other) {
    if (isImageProtected(text)) return false;
  }
  if (reAdded !== undefined && isImageProtected(reAdded)) return false;
  return true;
}

export function applyQueueOp(
  state: QueueState,
  op: QueueOp,
  isImageProtected: (text: string) => boolean = () => false,
): QueueOpResult {
  const list = listFor(state, op.kind);
  if (op.index < 0 || op.index >= list.length) {
    // Most likely the message was delivered between render and click — a
    // no-op signal, not a hard failure.
    return { ok: false, error: "index_out_of_bounds" };
  }

  const steering = [...state.steering];
  const followUp = [...state.followUp];
  const target = list[op.index]!;

  if (op.op === "edit") {
    const text = op.text.trim();
    if (text.length === 0) return { ok: false, error: "empty_text" };
    if (!rebuildIsSafe(state, op.kind, op.index, isImageProtected, text)) {
      return { ok: false, error: "image_protected" };
    }
    if (op.kind === "steering") steering[op.index] = text;
    else followUp[op.index] = text;
    return { ok: true, next: { steering, followUp } };
  }

  if (op.op === "delete") {
    // Deleting the protected message itself is fine — the image goes with it.
    if (!rebuildIsSafe(state, op.kind, op.index, isImageProtected)) {
      return { ok: false, error: "image_protected" };
    }
    if (op.kind === "steering") steering.splice(op.index, 1);
    else followUp.splice(op.index, 1);
    return { ok: true, next: { steering, followUp } };
  }

  if (op.op === "convert") {
    if (!rebuildIsSafe(state, op.kind, op.index, isImageProtected, target)) {
      return { ok: false, error: "image_protected" };
    }
    if (op.kind === "steering") {
      steering.splice(op.index, 1);
      followUp.push(target);
    } else {
      followUp.splice(op.index, 1);
      steering.push(target);
    }
    return { ok: true, next: { steering, followUp } };
  }

  // interrupt: the target leaves the queue and is re-sent as a fresh turn.
  if (!rebuildIsSafe(state, op.kind, op.index, isImageProtected, target)) {
    return { ok: false, error: "image_protected" };
  }
  if (op.kind === "steering") steering.splice(op.index, 1);
  else followUp.splice(op.index, 1);
  return { ok: true, next: { steering, followUp }, interruptedText: target };
}

/** Human-readable server error for the UI notice. */
export function describeQueueOpError(error: QueueOpError): string {
  switch (error) {
    case "index_out_of_bounds":
      return "消息不在队列中（可能刚刚已投递），请刷新后重试";
    case "empty_text":
      return "消息内容不能为空";
    case "image_protected":
      return "队列中存在带图片的消息，暂不支持此操作（避免重建队列时丢失图片）";
  }
}
