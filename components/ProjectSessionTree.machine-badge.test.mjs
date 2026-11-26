import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProjectSessionTree.tsx", import.meta.url), "utf8");

test("本机模式项目在项目行渲染机器徽标", () => {
  assert.match(source, /import \{ machineBadgeState \} from "@\/lib\/machine-badge"/);
  assert.match(source, /const \{ machines: relayMachines, ready: relayReady \} = useRelayAgent\(\)/);
  assert.match(source, /machineBadgeState\(project, relayReady \? \(relayMachines \?\? \[\]\) : undefined\)/);
  assert.match(source, /data-machine-state=\{machineBadge\.status\}/);
  assert.match(source, /data-machine-id=\{machineBadge\.machineId\}/);
});

test("机器徽标位于项目名之后，且不触发项目行的展开/折叠", () => {
  const start = source.indexOf("{machineBadge && (");
  assert.notEqual(start, -1, "machine badge block not found");
  const end = source.indexOf("{showBadge && (", start);
  assert.notEqual(end, -1, "projection badge must follow the machine badge");
  assert.ok(source.indexOf("{project.name}") < start, "machine badge follows the project name");
  const block = source.slice(start, end);
  assert.match(block, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
});

test("三种机器状态各自的文案与属性", () => {
  // 在线：label + （版本过低时）需升级，hover 给出 requiredVersion
  assert.match(source, /status === "online"/);
  assert.match(source, /sessions\.machineUpgradeHint/);
  assert.match(source, /sessions\.machineUpgrade"/);
  // 离线：未连接 + 最后在线时间
  assert.match(source, /status === "offline"/);
  assert.match(source, /sessions\.machineOffline/);
  assert.match(source, /sessions\.machineLastSeen/);
  // 已解配：琥珀色警示文案，后续「重新连接机器」入口靠 data-machine-state 定位
  assert.match(source, /status === "unpaired"/);
  assert.match(source, /sessions\.machineUnpaired/);
  assert.match(source, /color: machineBadge\.status === "unpaired" \? "var\(--warning\)"/);
});
