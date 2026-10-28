#!/usr/bin/env node
/**
 * Normalize the built-in i18n message files (lib/i18n/messages/{en,zh-CN,zh-TW}.ts):
 * rewrite every locale with the SAME, alphabetically sorted key order (one key
 * per line). Identical ordering makes the three files line-align in diffs, so
 * a missing key or a drifted translation shows up as a plain gap instead of
 * hiding in shuffled append-order.
 *
 * Safety: refuses to rewrite when the three key SETS differ (fix the gap
 * first — the registry test enforces the same invariant); values are copied
 * verbatim, never translated or merged.
 *
 * Usage: node scripts/i18n-normalize.mjs [--check]   (--check: verify only)
 */
import { createJiti } from "jiti";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const FILES = [
  { file: "en.ts", header: "/** Pi Web 内置英语语言包。 */", exportName: "enLocale" },
  { file: "zh-CN.ts", header: "/** Pi Web 内置简体中文语言包。 */", exportName: "zhCNLocale" },
  { file: "zh-TW.ts", header: "/** Pi Web 內建繁體中文語系。 */", exportName: "zhTWLocale" },
];

const locales = [];
for (const { file } of FILES) {
  const mod = await jiti.import(`../lib/i18n/messages/${file}`);
  // The module exports exactly one LocalePlugin; find it without hard-coding
  // the name twice.
  const plugin = Object.values(mod).find((v) => v && typeof v === "object" && "messages" in v && "id" in v);
  locales.push({ ...plugin, file: file });
}

// 1. Key sets must already be identical (registry test invariant).
const base = Object.keys(locales[0].messages).sort();
for (const locale of locales.slice(1)) {
  const mine = Object.keys(locale.messages).sort();
  const missing = base.filter((k) => !(k in locale.messages));
  const extra = mine.filter((k) => !(k in locales[0].messages));
  if (missing.length || extra.length) {
    console.error(`[i18n-normalize] key sets differ for ${locale.id}:`);
    if (missing.length) console.error("  missing:", missing.join(", "));
    if (extra.length) console.error("  extra:", extra.join(", "));
    process.exit(1);
  }
}

// 2. Canonical order: bytewise sort (stable across machines/ICUs; dot-keys
//    group by their prefix automatically).
const order = [...base].sort();

if (process.argv.includes("--check")) {
  // Compare key ORDER only (loaded from the live files) — not raw text, so
  // prettier formatting differences can't produce false positives.
  let outOfOrder = 0;
  for (const locale of locales) {
    const current = Object.keys(locale.messages);
    if (JSON.stringify(current) !== JSON.stringify(order)) outOfOrder += 1;
  }
  console.log(
    outOfOrder === 0
      ? "[i18n-normalize] OK — all locale files share the sorted key order."
      : `[i18n-normalize] ${outOfOrder} file(s) out of order — run without --check to rewrite.`,
  );
  process.exit(outOfOrder === 0 ? 0 : 1);
}

// 3. Emit every locale with that exact order.
let changed = 0;
for (const locale of locales) {
  const lines = [
    'import type { LocalePlugin } from "../types";',
    "",
    locale.headerText ?? headerFor(locale),
    `export const ${exportNameFor(locale)}: LocalePlugin = {`,
    `  id: ${JSON.stringify(locale.id)},`,
    `  label: ${JSON.stringify(locale.label)},`,
    "  messages: {",
    ...order.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(locale.messages[key])},`),
    "  },",
    "};",
    "",
  ].join("\n");
  const path = join(root, "lib", "i18n", "messages", locale.file);
  const before = readFileSync(path, "utf8");
  if (before !== lines) {
    changed += 1;
    writeFileSync(path, lines, "utf8");
  }
}

function headerFor(locale) {
  return FILES.find((f) => f.file === locale.file)?.header ?? `/** ${locale.label} locale. */`;
}
function exportNameFor(locale) {
  return FILES.find((f) => f.file === locale.file)?.exportName;
}

if (process.argv.includes("--check")) {
  console.log(
    changed === 0
      ? "[i18n-normalize] OK — all locale files share the sorted key order."
      : `[i18n-normalize] ${changed} file(s) out of order — run without --check to rewrite.`,
  );
  process.exit(changed === 0 ? 0 : 1);
}
console.log(`[i18n-normalize] rewrote ${changed}/${FILES.length} files with ${order.length} sorted keys.`);
