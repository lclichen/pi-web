import assert from "node:assert/strict";
import test from "node:test";
import { badgeCounts, isOwnSession, unreadStorageKey } from "./session-badge.ts";

test("badge counts ignore other users' sessions and subagents", () => {
  const sessions = [
    { id: "own", ownerId: 7 },
    { id: "other", ownerId: 8 },
    { id: "host", ownerId: 0 },
    { id: "legacy" },
    { id: "subagent", ownerId: 7, relation: { kind: "subagent" } },
  ];
  const running = new Set(["own", "other", "host", "legacy", "subagent"]);
  const unread = new Set(["own", "other", "host", "legacy", "subagent"]);

  assert.deepEqual(badgeCounts(sessions, running, unread, 7), { unread: 1, running: 1 });
  assert.deepEqual(badgeCounts(sessions, running, unread, 8), { unread: 1, running: 1 });
  assert.deepEqual(badgeCounts(sessions, running, unread, 0), { unread: 2, running: 2 });
});

test("ownership is the login itself; auth-off owns host/legacy rows", () => {
  assert.equal(isOwnSession({ id: "a", ownerId: 7 }, 7), true);
  assert.equal(isOwnSession({ id: "a", ownerId: 8 }, 7), false);
  assert.equal(isOwnSession({ id: "a", ownerId: 0 }, 7), false);
  assert.equal(isOwnSession({ id: "a" }, 7), false);
  assert.equal(isOwnSession({ id: "a", ownerId: 0 }, 0), true);
  assert.equal(isOwnSession({ id: "a" }, 0), true);
});

test("unread markers are keyed per login", () => {
  assert.equal(unreadStorageKey(7), "pi-web:unread-session-ids:u7");
  assert.equal(unreadStorageKey(8), "pi-web:unread-session-ids:u8");
  assert.equal(unreadStorageKey(0), "pi-web:unread-session-ids");
  assert.equal(unreadStorageKey(undefined), "pi-web:unread-session-ids");
});
