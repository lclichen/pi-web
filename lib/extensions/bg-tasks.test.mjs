import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSessionStopper } = await jiti.import("./bg-tasks.ts");

function fakeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, data) {
      emitted.push({ event, data });
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
    /** Deliver a package lifecycle event without recording it as an RPC. */
    fire(event, data) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
    emitted,
  };
}

function stopRequests(bus) {
  return bus.emitted
    .filter((entry) => entry.event === "subagents:rpc:stop")
    .map((entry) => entry.data.agentId);
}

test("Stop replays a stop request for every top-level agent the package announced", () => {
  const bus = fakeBus();
  const stopper = createSessionStopper(bus);

  bus.fire("subagents:started", { id: "foreground" });
  bus.fire("subagents:created", { id: "background" });
  bus.fire("subagents:started", { id: "foreground" }); // duplicate announcement
  bus.fire("subagents:completed", { id: "finished" });
  bus.fire("subagents:failed", { id: "crashed" });

  const outcome = stopper.stopAll();
  assert.deepEqual(outcome, { ok: true, stopped: 2 });
  assert.deepEqual(stopRequests(bus).sort(), ["background", "foreground"]);

  // The set is cleared: a second Stop does not replay stale ids.
  assert.deepEqual(stopper.stopAll(), { ok: true, stopped: 0 });
  assert.equal(stopRequests(bus).length, 2);
});

test("an agent that settles before Stop is forgotten and not stopped", () => {
  const bus = fakeBus();
  const stopper = createSessionStopper(bus);

  bus.fire("subagents:started", { id: "done" });
  bus.fire("subagents:completed", { id: "done" });
  bus.fire("subagents:started", { id: "still-running" });

  assert.equal(stopper.stopAll().stopped, 1);
  assert.deepEqual(stopRequests(bus), ["still-running"]);
});

test("a single-agent stop waits for the package's reply envelope", async () => {
  const bus = fakeBus();
  const stopper = createSessionStopper(bus);

  const pending = stopper.stop("agent-1");
  const request = bus.emitted.find((entry) => entry.event === "subagents:rpc:stop");
  assert.equal(request.data.agentId, "agent-1");
  assert.equal(typeof request.data.requestId, "string");

  bus.emit(`subagents:rpc:stop:reply:${request.data.requestId}`, { success: true });
  assert.deepEqual(await pending, { ok: true });
});

test("no package events means Stop is a no-op", () => {
  const bus = fakeBus();
  const stopper = createSessionStopper(bus);
  assert.deepEqual(stopper.stopAll(), { ok: true, stopped: 0 });
  assert.equal(bus.emitted.length, 0);
});
