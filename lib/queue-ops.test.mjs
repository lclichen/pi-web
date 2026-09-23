import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyQueueOp, describeQueueOpError } from "./queue-ops.ts";

/** Pure queue-op semantics for the update_queue command. */

const state = () => ({ steering: ["s1", "s2"], followUp: ["f1"] });

test("edit: replaces text in place, keeps the other list untouched", () => {
  const r = applyQueueOp(state(), { op: "edit", kind: "steering", index: 1, text: "s2-edited" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { steering: ["s1", "s2-edited"], followUp: ["f1"] });

  const r2 = applyQueueOp(state(), { op: "edit", kind: "followUp", index: 0, text: "f1-new" });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.next, { steering: ["s1", "s2"], followUp: ["f1-new"] });
});

test("edit: trims and rejects empty text, rejects out-of-bounds index", () => {
  assert.equal(applyQueueOp(state(), { op: "edit", kind: "steering", index: 0, text: "  x  " }).ok, true);
  assert.deepEqual(
    applyQueueOp(state(), { op: "edit", kind: "steering", index: 0, text: "   " }),
    { ok: false, error: "empty_text" },
  );
  assert.deepEqual(
    applyQueueOp(state(), { op: "edit", kind: "steering", index: 5, text: "x" }),
    { ok: false, error: "index_out_of_bounds" },
  );
  assert.deepEqual(
    applyQueueOp(state(), { op: "delete", kind: "followUp", index: 1 }),
    { ok: false, error: "index_out_of_bounds" },
  );
});

test("delete: removes the item without touching order", () => {
  const r = applyQueueOp(state(), { op: "delete", kind: "steering", index: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { steering: ["s2"], followUp: ["f1"] });
});

test("convert: moves the message to the end of the other list", () => {
  const toFollowUp = applyQueueOp(state(), { op: "convert", kind: "steering", index: 0 });
  assert.equal(toFollowUp.ok, true);
  assert.deepEqual(toFollowUp.next, { steering: ["s2"], followUp: ["f1", "s1"] });

  const toSteer = applyQueueOp(state(), { op: "convert", kind: "followUp", index: 0 });
  assert.equal(toSteer.ok, true);
  assert.deepEqual(toSteer.next, { steering: ["s1", "s2", "f1"], followUp: [] });
});

test("interrupt: removes the target and returns it for immediate send", () => {
  const r = applyQueueOp(state(), { op: "interrupt", kind: "followUp", index: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.interruptedText, "f1");
  assert.deepEqual(r.next, { steering: ["s1", "s2"], followUp: [] });

  // interrupt on a steering message also works (skip the boundary wait)
  const r2 = applyQueueOp(state(), { op: "interrupt", kind: "steering", index: 0 });
  assert.equal(r2.ok, true);
  assert.equal(r2.interruptedText, "s1");
});

test("image protection: ops that rebuild protected messages are rejected", () => {
  const protectedTexts = new Set(["s2", "f1"]);
  const isProtected = (t) => protectedTexts.has(t);

  // target itself protected → edit/convert/interrupt rejected
  for (const op of [
    { op: "edit", kind: "steering", index: 1, text: "x" },
    { op: "convert", kind: "steering", index: 1 },
    { op: "interrupt", kind: "followUp", index: 0 },
  ]) {
    assert.deepEqual(applyQueueOp(state(), op, isProtected), { ok: false, error: "image_protected" }, JSON.stringify(op));
  }

  // another queued message protected → even deleting a different one is rejected
  assert.deepEqual(
    applyQueueOp(state(), { op: "delete", kind: "steering", index: 0 }, isProtected),
    { ok: false, error: "image_protected" },
  );

  // deleting the protected message itself is allowed (image goes with it,
  // provided nothing else is protected)
  const onlyF1 = new Set(["f1"]);
  const r = applyQueueOp(state(), { op: "delete", kind: "followUp", index: 0 }, (t) => onlyF1.has(t));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { steering: ["s1", "s2"], followUp: [] });
});

test("purity: input arrays are never mutated", () => {
  const input = state();
  applyQueueOp(input, { op: "edit", kind: "steering", index: 0, text: "changed" });
  applyQueueOp(input, { op: "convert", kind: "steering", index: 0 });
  applyQueueOp(input, { op: "delete", kind: "followUp", index: 0 });
  assert.deepEqual(input, { steering: ["s1", "s2"], followUp: ["f1"] });
});

test("describeQueueOpError: every error maps to a message", () => {
  for (const err of ["index_out_of_bounds", "empty_text", "image_protected"]) {
    const msg = describeQueueOpError(err);
    assert.ok(typeof msg === "string" && msg.length > 0, err);
  }
});

// ---------------------------------------------------------------------------
// Wiring source assertions (rpc-manager is not loadable under strip-types:
// constructor parameter properties — assert on source instead)
// ---------------------------------------------------------------------------

test("rpc-manager: update_queue command drains, transforms, requeues atomically", async () => {
  const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "update_queue"/);
  assert.match(source, /applyQueueOp/);
  assert.match(source, /requeueMessages/);
  // Reject path must restore the drained queue before failing
  assert.match(source, /result\.ok[\s\S]{0,400}requeueMessages\(drained\)/);
  // Interrupt path aborts then prompts; failure requeues so the text is not lost
  assert.match(source, /interruptedText !== undefined/);
  assert.match(source, /inner\.abort\(\)/);
  assert.match(source, /inner\.prompt\(result\.interruptedText/);
});

test("rpc-manager: image-bearing queued texts are tracked and pruned", async () => {
  const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /queuedImageTexts/);
  assert.match(source, /pruneQueuedImageTexts/);
  // Tracking happens on prompt/steer/follow_up with images
  const promptTracks = source.includes("promptImages?.length && streamingBehavior") && source.includes("queuedImageTexts.add");
  assert.ok(promptTracks, "prompt-with-images must record the text");
});

test("ChatInput: queued rows expose convert/edit/interrupt/delete via onQueueOp", async () => {
  const source = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /onQueueOp\?\.\(\{ op: "edit"/);
  assert.match(source, /onQueueOp\?\.\(\{ op: "delete"/);
  assert.match(source, /onQueueOp\?\.\(\{ op: "convert"/);
  assert.match(source, /onQueueOp\?\.\(\{ op: "interrupt"/);
  // Type tooltips make the two queue kinds explicit
  assert.match(source, /chat\.queueSteerTip/);
  assert.match(source, /chat\.queueFollowUpTip/);
});
