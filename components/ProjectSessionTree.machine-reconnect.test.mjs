import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProjectSessionTree.tsx", import.meta.url), "utf8");

test("项目菜单：绑定机器已解配/离线时显示「重新连接机器」入口", () => {
  assert.match(source, /import \{ countUnpairedMachineProjects, needsMachineReconnect \} from "@\/lib\/project-machine-reconnect"/);
  // 判定复用机器徽标（machineBadgeState）的状态：unpaired / offline。
  assert.match(
    source,
    /needsMachineReconnect\(menuProject, relayReady \? \(relayMachines \?\? \[\]\) : undefined\)/,
  );
  assert.match(source, /label=\{t\("sessions\.machineReconnect"\)\}/);
  assert.match(source, /hint=\{t\("sessions\.machineReconnectHint"\)\}/);
  // 点击打开对话框并关闭菜单（与其他菜单项一致）。
  assert.match(source, /setReconnectProject\(menuProject\);\s*setMenu\(null\);/);
});

test("重新连接对话框挂载：成功后刷新项目列表与会话", () => {
  assert.match(source, /import \{ ReconnectMachineDialog \} from "\.\/ReconnectMachineDialog"/);
  const start = source.indexOf("{reconnectProject && (");
  assert.notEqual(start, -1, "reconnect dialog mount not found");
  const end = source.indexOf("{settingsId && (", start);
  assert.notEqual(end, -1, "settings dialog must follow");
  const block = source.slice(start, end);
  assert.match(block, /<ReconnectMachineDialog/);
  assert.match(block, /onReconnected=\{\(\) => \{/);
  assert.match(block, /loadProjects\(\)/);
  assert.match(block, /refreshSessions\(\)/);
});

test("上线提示：有机器在线且存在已解配的本机项目时在项目列表上方提示", () => {
  assert.match(
    source,
    /countUnpairedMachineProjects\(orderedProjects, relayReady \? \(relayMachines \?\? \[\]\) : undefined\)/,
  );
  const start = source.indexOf("unpairedMachineProjects > 0 && (");
  assert.notEqual(start, -1, "banner block not found");
  const block = source.slice(start, start + 800);
  assert.match(block, /role="status"/);
  assert.match(block, /t\("sessions\.machineReconnectBanner", \{ count: unpairedMachineProjects \}\)/);
  // 只提示，不自动改绑：该块里不得出现 PATCH / 改绑调用。
  assert.doesNotMatch(block, /machineId/);
  // 项目列表在其后渲染（提示在项目行上方）。
  assert.ok(source.indexOf("{sessionSpace === \"mine\" &&\n            orderedProjects") > start, "banner precedes project rows");
});
