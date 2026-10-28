#!/usr/bin/env node
/** One-off codemod: make source-shape test regexes whitespace-tolerant where
 *  prettier reformatting split their literal. Run: node scripts/tolerize-tests.mjs <files...> */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = process.argv.slice(2);
let total = 0;
for (const f of files) {
  let out = "";
  try {
    out = execSync(`node --experimental-strip-types --test ${JSON.stringify(f)} 2>&1`, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = e.stdout || "";
  }
  const patterns = [...out.matchAll(/did not match the regular expression \/(.*)\/(?::|\.)/g)].map((m) => m[1]);
  if (!patterns.length) continue;
  let src = readFileSync(f, "utf8");
  let n = 0;
  for (const p of new Set(patterns)) {
    const tol = p.split(" ").join("\\s+");
    if (tol === p) continue;
    const before = src;
    src = src.split(`/${p}/`).join(`/${tol}/`);
    if (src !== before) n += 1;
  }
  if (n > 0) {
    writeFileSync(f, src);
    total += n;
    console.log(`${f}: tolerized ${n}`);
  }
}
console.log(`TOTAL ${total}`);
