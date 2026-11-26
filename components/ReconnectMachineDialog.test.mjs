import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ReconnectMachineDialog.tsx", import.meta.url), "utf8");

test("对话框读取本项目自己的 workdir（publicProject 不含路径）", () => {
  // 专用接口：/api/projects/:id/machine —— 不是从项目列表/详情里拿 workdir。
  assert.match(source, /fetch\(`\/api\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/machine`\)/);
  assert.match(source, /setWorkdir\(d\.workdir \?\? ""\)/);
});

test("机器选择：在线优先、单机预选、离线也可选（灰度 + 提示）", () => {
  assert.match(source, /sortReconnectMachines\(machines \?\? \[\]\)/);
  // 默认选中：只有一台机器时选它；多台不预选（避免误连到别的机器）。
  assert.match(source, /setSelected\(machineList\.length === 1 \? machineList\[0\]\.machineId : ""\)/);
  assert.match(source, /machine\.online \? "var\(--success\)" : "#9ca3af"/);
  assert.match(source, /t\("sessions\.machineOfflineNoValidate"\)/);
  // 一台都没配对：给出准确入口（顶部「环境」菜单 →「本地机器」）。
  assert.match(source, /t\("sessions\.machineReconnectNoMachines"\)/);
});

test("目录：在线机器可用 DirectoryPicker（relay browse），离线退化为手填", () => {
  assert.match(source, /const browseAllowed = Boolean\(selectedMachine\?\.online\)/);
  assert.match(source, /<DirectoryPicker/);
  assert.match(source, /source=\{relaySource\}/);
  assert.match(source, /\/api\/agent-relay\/browse\?\$\{qs\.toString\(\)\}/);
  assert.match(source, /qs\.set\("machineId", selected\)/);
  assert.match(source, /disabled=\{!browseAllowed\}/);
});

test("提交：PATCH /api/projects/:id，body 为 { machineId, workdir? }，失败 alert 服务端 error", () => {
  assert.match(source, /body: JSON\.stringify\(buildMachineReconnectPatch\(selected, workdir\)\)/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /window\.alert\(d\.error \?\? t\("sessions\.operationFailedHttp", \{ code: res\.status \}\)\)/);
  // 成功后刷新 relay 快照并回调宿主刷新项目列表。
  assert.match(source, /refresh\(\);\s*onReconnected\(\);\s*onClose\(\);/);
  // 空目录不允许提交（服务端空串会清掉 workdir）；离线机器也不能提交
  // （目录无法在目标机器上校验）。
  assert.match(source, /const canSubmit =\s*!busy && Boolean\(selected\) && Boolean\(workdir\.trim\(\)\) && Boolean\(selectedMachine\?\.online\)/);
});
