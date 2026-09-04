import test from "node:test";
import assert from "node:assert/strict";
import { createShutdownHandler, signalExitCode } from "./shutdown.ts";

test("shutdown: closes servers, force-exits after the grace window", () => {
  const events = [];
  const shutdown = createShutdownHandler({
    closeServers: () => events.push("close-servers"),
    exit: (code) => events.push(["exit", code]),
    schedule: (fn, ms) => {
      events.push(["scheduled", ms]);
      fn();
    },
    delayMs: 2_000,
  });
  shutdown("SIGINT");
  assert.deepEqual(events, [
    "close-servers",
    ["scheduled", 2_000],
    ["exit", 130],
  ]);
});

test("shutdown: once-only — a second Ctrl+C does nothing extra", () => {
  let exits = 0;
  const shutdown = createShutdownHandler({
    closeServers: () => {},
    exit: () => { exits += 1; },
    schedule: (fn) => fn(),
  });
  shutdown("SIGINT");
  shutdown("SIGINT");
  shutdown("SIGTERM");
  assert.equal(exits, 1);
});

test("shutdown: cleanup errors never block the exit", () => {
  let exited = null;
  const shutdown = createShutdownHandler({
    closeServers: () => { throw new Error("boom"); },
    exit: (code) => { exited = code; },
    schedule: (fn) => fn(),
  });
  shutdown("SIGTERM");
  assert.equal(exited, 143);
});

test("shutdown: SIGTERM maps to 143, anything else to 130", () => {
  assert.equal(signalExitCode("SIGTERM"), 143);
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGHUP"), 130);
});
