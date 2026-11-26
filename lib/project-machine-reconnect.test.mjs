import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  needsMachineReconnect,
  sortReconnectMachines,
  buildMachineReconnectPatch,
  countUnpairedMachineProjects,
} = await jiti.import("./project-machine-reconnect.ts");

const local = (machineId) => ({ mode: "local-machine", ...(machineId ? { machineId } : {}) });

test("重新连接入口：已解配或绑定机器离线时显示", () => {
  const machines = [
    { machineId: "m-online", label: "Online box", online: true },
    { machineId: "m-offline", label: "Offline box", online: false },
  ];
  assert.equal(needsMachineReconnect(local("gone"), machines), true, "unpaired");
  assert.equal(needsMachineReconnect(local("m-offline"), machines), true, "offline");
  assert.equal(needsMachineReconnect(local("m-online"), machines), false, "online");
  // 机器目录未到达 / 非本机模式 / 空项目：不显示。
  assert.equal(needsMachineReconnect(local("m-online"), undefined), false);
  assert.equal(needsMachineReconnect({ mode: "sandbox", machineId: "gone" }, machines), false);
  assert.equal(needsMachineReconnect(null, machines), false);
});

test("机器选择列表：在线优先，同状态按显示名排序，不改入参", () => {
  const input = [
    { machineId: "b", label: "Beta", online: false },
    { machineId: "a", label: "Alpha", online: true },
    { machineId: "c", online: true, hostname: "gamma-host" },
    { machineId: "d", label: "Delta", online: false },
  ];
  const sorted = sortReconnectMachines(input);
  assert.deepEqual(
    sorted.map((m) => m.machineId),
    ["a", "c", "b", "d"],
  );
  assert.deepEqual(
    input.map((m) => m.machineId),
    ["b", "a", "c", "d"],
    "入参顺序保持不变",
  );
});

test("提交体：{ machineId, workdir? }，目录去空白，空目录不落 body", () => {
  assert.deepEqual(buildMachineReconnectPatch("m2", "  /srv/new dir  "), {
    machineId: "m2",
    workdir: "/srv/new dir",
  });
  assert.deepEqual(buildMachineReconnectPatch("m2", "   "), { machineId: "m2" });
});

test("上线提示计数：有机器在线且存在已解配的本机项目", () => {
  const projects = [
    local("gone-1"),
    local("gone-2"),
    local("m-online"),
    { mode: "sandbox", machineId: "gone-3" },
  ];
  const machines = [{ machineId: "m-online", label: "Box", online: true }];
  assert.equal(countUnpairedMachineProjects(projects, machines), 2);
  // 没有在线机器（全离线）/ 目录未到达：不提示。
  assert.equal(
    countUnpairedMachineProjects(projects, [
      { machineId: "m-online", label: "Box", online: false },
    ]),
    0,
  );
  assert.equal(countUnpairedMachineProjects(projects, undefined), 0);
  // 没有解配项目：不提示。
  assert.equal(countUnpairedMachineProjects([local("m-online")], machines), 0);
});
