import assert from "node:assert/strict";
import test from "node:test";

const { anySidebarGroupExpanded, setAllSidebarGroups, sortSidebarGroups } = await import("./sidebar-groups.ts");

const group = (key, mode, latest, extra = {}) => ({
  key,
  name: key,
  mode,
  latest,
  pinned: false,
  pinRank: -1,
  ...extra,
});

test("project-first sorts every group by its newest session, ignoring mode", () => {
  const sorted = sortSidebarGroups(
    [
      group("host-old", "host", "2026-01-01T00:00:00Z"),
      group("sandbox-new", "sandbox", "2026-03-01T00:00:00Z"),
      group("local-mid", "local-machine", "2026-02-01T00:00:00Z"),
    ],
    "project",
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

test("pinned groups lead in pin order, whatever the sort mode", () => {
  for (const mode of ["project", "connection"]) {
    const sorted = sortSidebarGroups(
      [
        group("newest", "sandbox", "2026-04-01T00:00:00Z"),
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
