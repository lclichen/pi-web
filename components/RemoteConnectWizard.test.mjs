import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./RemoteConnectWizard.tsx", import.meta.url), "utf8");
const relaySource = await readFile(new URL("./relay/ConnectLocalMachine.tsx", import.meta.url), "utf8");

/**
 * 本地模式向导第③步的回归点（用户实测两个 bug）：
 *  1) 未配对进入第③步、就地配对成功后：页面只更新“已连接”，不进下一步，
 *     顶部“本机尚未配对”横幅也不消失（本地轮询 + 常驻 error 横幅的 stale）。
 *  2) 第④步点“上一步”回到第③步，但第③步检测到机器在线立即 setStep(4)
 *     弹回，单机时等于无法回退。
 * 现第③步 = 机器选择页：useRelayAgent 的 SSE 列表驱动 + 内嵌配对 +
 * 显式“下一步”，不再自动跳步。
 */

test("local step 3 is a machine-selection page, not an auto-advance gate", () => {
  // 旧的本地轮询/常驻横幅路径已删除（stale 横幅与自动跳步的根源）。
  assert.doesNotMatch(source, /relayInfo/);
  assert.doesNotMatch(source, /setInterval\(check/);
  assert.doesNotMatch(source, /localMachinePairedCompletePairing/);

  const localStep = source.slice(source.indexOf('step === 3 && method === "local"'));
  assert.match(localStep, /localMachineList\.map/, "machine rows must render");
  assert.match(localStep, /<PairingSteps/, "pairing happens in place");
  assert.match(localStep, /localPairOpen/, "pairing section toggles when machines exist");
  assert.match(localStep, /disabled=\{!localMachineReady\}/, "even one machine needs an explicit Next");
  assert.match(localStep, /onClick=\{\(\) => setStep\(2\)\}/, "step 3 keeps its own Back button");
  assert.match(localStep, /noPairedMachines/, "empty state explains pairing below");
  // 无机器时配对区已 flex:1 撑满；占位必须一起隐藏，否则高度被对半分。
  assert.match(localStep, /\{localMachineList\.length > 0 && <div style=\{\{ flex: 1 \}\} \/>\}/);
});

test("machine list is SSE-driven and preselect never advances", () => {
  const preselect = source.slice(
    source.indexOf("const preferred"),
    source.indexOf("setLocalMachineId(preferred.machineId);") + 41,
  );
  assert.match(preselect, /list\.find\(\(m\) => m\.online && m\.compatible !== false\)/);
  assert.doesNotMatch(preselect, /setStep\(4\)/);
  assert.match(source, /const \{ machines: relayMachines, requiredVersion \} = useRelayAgent\(\)/);
});

test("stepper relabels step 3 for local mode and step 4 keeps its back button", () => {
  assert.match(source, /s\.n === 3 && method === "local" \? t\("remote\.stepChooseMachine"\)/);
  const localStep4 = source.slice(source.indexOf('step === 4 && method === "local"'));
  assert.match(localStep4, /onClick=\{\(\) => setStep\(3\)\}/);
});

test("pairing UI stays shared instead of duplicated", () => {
  assert.match(relaySource, /export function PairingSteps/);
  assert.match(relaySource, /export function useAgentInstallInfo/);
  assert.match(source, /import \{ PairingSteps, useAgentInstallInfo \} from "\.\/relay\/ConnectLocalMachine"/);
});
