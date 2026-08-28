// 补词条 + 转换 ProjectSessionTree 剩余动态字符串
const fs = require("fs");
let en = fs.readFileSync("lib/i18n/messages/en.ts", "utf8");
let zh = fs.readFileSync("lib/i18n/messages/zh-CN.ts", "utf8");
const pairs = [
  ["容器：{info}", "Container: {info}"],
  ["↩ 恢复存档 · {time}", "↩ Restore save · {time}"],
];
for (const [k, v] of pairs) {
  if (!en.includes(JSON.stringify(k) + ":")) {
    en = en.replace('    "common.plugins"', "    " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",\n    \"common.plugins\"");
  }
  if (!zh.includes(JSON.stringify(k) + ":")) {
    zh = zh.replace('    "common.plugins"', "    " + JSON.stringify(k) + ": " + JSON.stringify(k) + ",\n    \"common.plugins\"");
  }
}
fs.writeFileSync("lib/i18n/messages/en.ts", en);
fs.writeFileSync("lib/i18n/messages/zh-CN.ts", zh);

let s = fs.readFileSync("components/ProjectSessionTree.tsx", "utf8");
const pairs2 = [
  [
    "title={`容器：${bound ? `#${bound.id} ${bound.name} · ${containerState.label}${bound.imageName ? ` · ${bound.imageName}` : \"\"}` : containerState.label}`}",
    'title={t("容器：{info}", { info: bound ? `#${bound.id} ${bound.name} · ${containerState.label}${bound.imageName ? ` · ${bound.imageName}` : ""}` : containerState.label })}',
  ],
  [
    "容器 {boundInfo ? `#${boundInfo.id} · ${boundInfo.status === \"running\" ? \"运行中\" : boundInfo.s",
    '{t("容器：{info}", { info: boundInfo ? `#${boundInfo.id} · ${boundInfo.status === "running" ? t("运行中") : boundInfo.s',
  ],
  [
    "<br />存档 {menu.project.snapshotSlots?.length ?? 0}/2（游戏存档制，保留最近 2 个）",
    '{t("存档 {n}/2（游戏存档制，保留最近 2 个）", { n: menu.project.snapshotSlots?.length ?? 0 })}',
  ],
  [
    "label={`↩ 恢复存档 · ${new Date(slot.createdAt).toLocaleString()}`}",
    'label={t("↩ 恢复存档 · {time}", { time: new Date(slot.createdAt).toLocaleString() })}',
  ],
];
let ok = 0;
const miss = [];
for (const [a, b] of pairs2) {
  if (s.includes(a)) { s = s.split(a).join(b); ok++; }
  else miss.push(a.slice(0, 60));
}
fs.writeFileSync("components/ProjectSessionTree.tsx", s);
console.log("pass4:", ok, "/", pairs2.length);
miss.forEach((m) => console.log(" MISS", m));
