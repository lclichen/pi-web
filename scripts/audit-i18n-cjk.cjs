// 审计脚本 v2：区分「已走 i18n 的中文」(t("…")/translate("…")) 与「裸中文」（遗漏）
const fs = require("fs"), path = require("path");
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(f) && !f.includes(".test.")) files.push(p);
  }
})("components");
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(f) && !f.includes(".test.")) files.push(p);
  }
})("app");
const cjk = /[\u4e00-\u9fff]/;
const wrapped = /(t|translate)\(\s*["'`][^"'`]*[\u4e00-\u9fff]/; // t("中文…")
const report = {};
let totalRaw = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  let raw = 0;
  const samples = [];
  lines.forEach((l, i) => {
    const noComment = l.split("//")[0];
    if (!cjk.test(noComment)) return;
    if (wrapped.test(noComment)) return; // 已走 i18n
    raw++;
    if (samples.length < 3) samples.push(`${i + 1}: ${l.trim().slice(0, 70)}`);
  });
  if (raw > 0) {
    report[f.split(path.sep).join("/")] = { raw, samples };
    totalRaw += raw;
  }
}
const sorted = Object.entries(report).sort((a, b) => b[1].raw - a[1].raw);
console.log("仍有裸中文（未走 i18n）的文件数:", sorted.length, " 总行数:", totalRaw);
for (const [f, { raw, samples }] of sorted) {
  console.log(String(raw).padStart(4), f);
  for (const s of samples) console.log("        ", s);
}
