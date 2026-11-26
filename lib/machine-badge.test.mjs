import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { machineBadgeState, machineDisplayName } = await jiti.import("./machine-badge.ts");

const localProject = (machineId) => ({
  mode: "local-machine",
  ...(machineId ? { machineId } : {}),
});

test("非本机模式项目不显示机器徽标", () => {
  for (const mode of ["sandbox", "ssh", "host", "quick", undefined]) {
    assert.equal(machineBadgeState({ mode }, [{ machineId: "m1", online: true }]), null, `mode=${mode}`);
  }
  assert.equal(machineBadgeState(null, []), null);
  assert.equal(machineBadgeState(undefined, []), null);
});

test("机器目录未到达时不做判定（避免先闪一下「已解配」）", () => {
  assert.equal(machineBadgeState(localProject("m1"), undefined), null);
  assert.equal(machineBadgeState(localProject("m1"), null), null);
});

test("在线机器：显示 label；版本过低时带升级信息", () => {
  const machines = [
    { machineId: "abc12345", label: "Build box", online: true, compatible: false, requiredVersion: "0.9.0" },
  ];
  assert.deepEqual(machineBadgeState(localProject("abc12345"), machines), {
    machineId: "abc12345",
    status: "online",
    name: "Build box",
    upgradeRequired: true,
    requiredVersion: "0.9.0",
  });
  // compatible 缺省 / true → 不需要升级
  const ok = machineBadgeState(localProject("abc12345"), [{ machineId: "abc12345", label: "Build box", online: true }]);
  assert.equal(ok.status, "online");
  assert.equal(ok.upgradeRequired, false);
  assert.equal(ok.requiredVersion, undefined);
});

test("离线机器：保留最后在线时间，非法时间被丢弃", () => {
  const badge = machineBadgeState(localProject("m1"), [
    { machineId: "m1", label: "Laptop", online: false, lastSeenAt: "2026-11-20T08:00:00.000Z" },
  ]);
  assert.equal(badge.status, "offline");
  assert.equal(badge.name, "Laptop");
  assert.equal(badge.lastSeenAt, "2026-11-20T08:00:00.000Z");
  const broken = machineBadgeState(localProject("m1"), [{ machineId: "m1", online: false, lastSeenAt: "not-a-date" }]);
  assert.equal(broken.status, "offline");
  assert.equal(broken.lastSeenAt, undefined);
});

test("机器目录里找不到 project.machineId = 已解配", () => {
  const badge = machineBadgeState(localProject("old-machine-id"), [
    { machineId: "new-machine", label: "New", online: true },
  ]);
  assert.deepEqual(badge, {
    machineId: "old-machine-id",
    status: "unpaired",
    name: "old-mach",
    upgradeRequired: false,
  });
});

test("legacy 项目（无 machineId）按默认机器判定", () => {
  const badge = machineBadgeState(localProject(), [{ machineId: "default", label: "Only box", online: true }]);
  assert.equal(badge.machineId, "default");
  assert.equal(badge.status, "online");
  assert.equal(badge.name, "Only box");
  // 默认机器也不存在 → 已解配
  const unpaired = machineBadgeState(localProject(), []);
  assert.equal(unpaired.machineId, "default");
  assert.equal(unpaired.status, "unpaired");
});

test("显示名回退顺序：label → hostname → machineId 前 8 位", () => {
  const machineId = "abcdef0123456789";
  assert.equal(machineDisplayName({ machineId, online: true, label: "Label", hostname: "host" }), "Label");
  assert.equal(machineDisplayName({ machineId, online: true, hostname: "host" }), "host");
  assert.equal(machineDisplayName({ machineId, online: true }), "abcdef01");
  assert.equal(
    machineBadgeState(localProject(machineId), [{ machineId, online: true, hostname: "host" }]).name,
    "host",
  );
});
