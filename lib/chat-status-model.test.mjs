import assert from "node:assert/strict";
import test from "node:test";
import { buildCollapsedSummary, capsuleVisible, todoFocusWindow } from "./chat-status-model.ts";

/** Capsule model layer: fallback chain, idle retirement, focus window. */

const step = (content, status = "pending") => ({ id: 1, content, status });
const base = {
  todos: [], goal: null, git: null,
  runningSubagents: 0, endedSubagents: 0,
  bashRunning: false, agentRunning: false, hasPlan: false,
};

test("fallback chain: todo current step wins over everything", () => {
  const s = buildCollapsedSummary({
    ...base,
    todos: [step("a", "completed"), step("b", "in_progress"), step("c")],
    goal: "重构解析器",
    git: { additions: 5, deletions: 2 },
    hasPlan: true,
    agentRunning: true,
  });
  assert.deepEqual(s, { kind: "todo", step: "b", done: 1, total: 3 });
});

test("fallback chain: goal → git → plan → activity → idle", () => {
  assert.equal(buildCollapsedSummary({ ...base, goal: "目标A" }).kind, "goal");

  const git = buildCollapsedSummary({ ...base, git: { additions: 5, deletions: 2 } });
  assert.deepEqual(git, { kind: "git", additions: 5, deletions: 2 });
  // Empty diff does not pin the git row.
  assert.equal(buildCollapsedSummary({ ...base, git: { additions: 0, deletions: 0 } }).kind, "idle");

  assert.equal(buildCollapsedSummary({ ...base, hasPlan: true }).kind, "plan");

  const act = buildCollapsedSummary({ ...base, runningSubagents: 2 });
  assert.deepEqual(act, { kind: "activity", subagents: 2, bash: false, agent: false, mixed: false });
  const mixed = buildCollapsedSummary({ ...base, runningSubagents: 1, bashRunning: true });
  assert.equal(mixed.mixed, true);
  const agentOnly = buildCollapsedSummary({ ...base, agentRunning: true });
  assert.deepEqual(agentOnly, { kind: "activity", subagents: 0, bash: false, agent: true, mixed: false });

  assert.equal(buildCollapsedSummary(base).kind, "idle");
});

test("capsuleVisible: idle retires the capsule; plan mode keeps it alive", () => {
  assert.equal(capsuleVisible({ kind: "idle" }, false), false);
  assert.equal(capsuleVisible({ kind: "idle" }, true), true);
  assert.equal(capsuleVisible({ kind: "todo", step: "x", done: 0, total: 1 }, false), true);
});

test("todoFocusWindow: short lists render in full", () => {
  const todos = [1, 2, 3].map((i) => ({ id: i, content: `s${i}`, status: "pending" }));
  const out = todoFocusWindow(todos);
  assert.equal(out.length, 3);
  assert.ok(out.every((e) => e.type === "item"));
});

test("todoFocusWindow: long lists center on the current step with merged edge markers", () => {
  const todos = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    content: `step-${i + 1}`,
    status: i < 4 ? "completed" : i === 4 ? "in_progress" : "pending",
  }));
  const out = todoFocusWindow(todos);
  // Center = first in_progress/pending (index 4); window = 2..6.
  const items = out.filter((e) => e.type === "item");
  assert.deepEqual(items.map((e) => e.item.id), [3, 4, 5, 6, 7]);
  // Two merged markers, each carrying its hidden items.
  const markers = out.filter((e) => e.type === "marker");
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0].hidden.map((h) => h.id), [1, 2]);
  assert.deepEqual(markers[1].hidden.map((h) => h.id), [8, 9, 10, 11, 12]);

  // All-done long list centers on the LAST item → window clamps to the tail
  // (ids 7-8-9 for pad=2 around item 9 of 9).
  const done = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, content: `d${i}`, status: "completed" }));
  const tail = todoFocusWindow(done);
  const tailItems = tail.filter((e) => e.type === "item");
  assert.deepEqual(tailItems.map((e) => e.item.id), [7, 8, 9]);
  const tailMarkers = tail.filter((e) => e.type === "marker");
  assert.equal(tailMarkers.length, 1);
  assert.deepEqual(tailMarkers[0].hidden.map((h) => h.id), [1, 2, 3, 4, 5, 6]);
});
