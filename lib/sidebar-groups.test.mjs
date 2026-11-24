import assert from "node:assert/strict";
import test from "node:test";

const { anySidebarGroupExpanded, mergeProjectOrder, setAllSidebarGroups, sortSidebarGroups } = await import(
  "./sidebar-groups.ts"
);

const group = (key, mode, latest, extra = {}) => ({
  key,
  name: key,
  mode,
  latest,
  pinned: false,
  pinRank: -1,
  ...extra,
});

test("project-first sorts by project creation time and ignores session activity", () => {
  const sorted = sortSidebarGroups(
    [
      group("created-old", "host", "2026-04-01T00:00:00Z", { createdAt: 1 }),
      group("created-new", "sandbox", "2026-01-01T00:00:00Z", { createdAt: 3 }),
      group("created-mid", "local-machine", "2026-03-01T00:00:00Z", { createdAt: 2 }),
    ],
    "project",
  );
  assert.deepEqual(
    sorted.map((item) => item.key),
    ["created-new", "created-mid", "created-old"],
  );
});

test("project-first honors the user's drag order before creation time", () => {
  const sorted = sortSidebarGroups(
    [
      group("second", "sandbox", "2026-04-01T00:00:00Z", { createdAt: 3, orderIndex: 1 }),
      group("first", "sandbox", "2026-01-01T00:00:00Z", { createdAt: 1, orderIndex: 0 }),
      group("unordered", "sandbox", "2026-02-01T00:00:00Z", { createdAt: 2 }),
    ],
    "project",
  );
  assert.deepEqual(
    sorted.map((item) => item.key),
    ["first", "second", "unordered"],
  );
});

test("session-first sorts every group by its newest session, ignoring mode", () => {
  const sorted = sortSidebarGroups(
    [
      group("host-old", "host", "2026-01-01T00:00:00Z"),
      group("sandbox-new", "sandbox", "2026-03-01T00:00:00Z"),
      group("local-mid", "local-machine", "2026-02-01T00:00:00Z"),
    ],
    "session",
  );
  assert.deepEqual(
    sorted.map((item) => item.key),
    ["sandbox-new", "local-mid", "host-old"],
  );
});

test("connection-first orders types by their newest session, then projects inside each type", () => {
  const sorted = sortSidebarGroups(
    [
      group("sandbox-old", "sandbox", "2026-01-01T00:00:00Z"),
      group("host-newest", "host", "2026-04-01T00:00:00Z"),
      group("sandbox-new", "sandbox", "2026-03-01T00:00:00Z"),
      group("local-mid", "local-machine", "2026-02-01T00:00:00Z"),
    ],
    "connection",
  );
  assert.deepEqual(
    sorted.map((item) => item.key),
    ["host-newest", "sandbox-new", "sandbox-old", "local-mid"],
  );
});

test("missing groups are merged by creation time instead of sinking to the bottom", () => {
  const visible = [
    { key: "project:old", name: "old", createdAt: 1 },
    { key: "host:new", name: "new host", createdAt: 3 },
    { key: "project:mid", name: "mid", createdAt: 2 },
  ];
  assert.deepEqual(mergeProjectOrder(visible, ["project:old"]), [
    "host:new",
    "project:mid",
    "project:old",
  ]);
  assert.deepEqual(mergeProjectOrder(visible, []), ["host:new", "project:mid", "project:old"]);
});

test("pinned groups lead in pin order, whatever the sort mode", () => {
  for (const mode of ["project", "session", "connection"]) {
    const sorted = sortSidebarGroups(
      [
        group("newest", "sandbox", "2026-04-01T00:00:00Z", { createdAt: 4 }),
        group("second-pin", "ssh", "2026-01-01T00:00:00Z", { pinned: true, pinRank: 1 }),
        group("first-pin", "host", "2026-02-01T00:00:00Z", { pinned: true, pinRank: 0 }),
      ],
      mode,
    );
    assert.deepEqual(
      sorted.map((item) => item.key),
      ["first-pin", "second-pin", "newest"],
    );
  }
});

test("collapse-all and expand-all touch exactly the expandable groups", () => {
  const keys = ["a", "b"];
  const collapsed = setAllSidebarGroups(new Set(["other"]), keys, true);
  assert.deepEqual([...collapsed].sort(), ["a", "b", "other"]);
  assert.equal(anySidebarGroupExpanded(keys, collapsed), false);

  const expanded = setAllSidebarGroups(collapsed, keys, false);
  assert.deepEqual([...expanded], ["other"]);
  assert.equal(anySidebarGroupExpanded(keys, expanded), true);
});
