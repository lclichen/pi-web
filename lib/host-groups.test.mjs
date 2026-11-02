import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildHostGroups, hostDirLabel } = await jiti.import("./host-groups.ts");

test("host dir labels handle POSIX and Windows separators", () => {
  assert.equal(hostDirLabel("/srv/app"), "app");
  assert.equal(hostDirLabel("/srv/app/"), "app");
  assert.equal(hostDirLabel("D:\\MyCourses\\proj"), "proj");
  assert.equal(hostDirLabel("D:/MyCourses/proj"), "proj");
});

test("host groups: sessions by projectRoot/cwd, registry adds empty groups once", () => {
  const sessions = [
    { mode: "host", projectRoot: "/srv/a", cwd: "/srv/a/sub", modified: "2026-11-02T10:00:00Z" },
    { mode: "host", cwd: "/srv/b", modified: "2026-11-02T09:00:00Z" },
    // 未绑定 project 的沙箱会话不属于 Host 目录组
    { mode: "sandbox", projectRoot: "/srv/a", cwd: "/home/u1/p", modified: "2026-11-02T11:00:00Z" },
  ];
  const groups = buildHostGroups(sessions, [{ root: "/srv/a" }, { root: "/srv/empty" }]);
  const byRoot = new Map(groups);
  assert.equal(byRoot.get("/srv/a")?.length, 1, "同一目录的会话合并");
  assert.equal(byRoot.get("/srv/b")?.length, 1);
  assert.equal(byRoot.get("/srv/empty")?.length, 0, "注册表空目录补空组");
  assert.equal(groups.length, 3, "有会话的目录不因注册表重复");
  // 有会话的组按最近会话倒序；空组排在最后
  assert.deepEqual(
    groups.map(([root]) => root),
    ["/srv/a", "/srv/b", "/srv/empty"],
  );
});

test("host groups: no registry = exactly the dynamic groups", () => {
  const groups = buildHostGroups(
    [{ mode: "host", cwd: "/srv/x", modified: "2026-11-02T10:00:00Z" }],
    [],
  );
  assert.deepEqual(groups.map(([root]) => root), ["/srv/x"]);
});
