const fs = require("fs");
const path = require("path");
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}
const routes = walk("app/api").sort();
const rows = [];
for (const f of routes) {
  const s = fs.readFileSync(f, "utf8");
  const api = f.split(path.sep).join("/").replace("app/api/", "").replace("/route.ts", "");
  const methods = [...s.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD)/g)].map((m) => m[1]).join(",");
  let gate = "NONE?";
  if (s.includes("requireAdminIdentity")) gate = "admin";
  else if (s.includes("requireBatchIdentity")) gate = "batch";
  else if (s.includes("requireUserIdentity")) gate = "login";
  else if (s.includes("getWebSession") || s.includes('from "@/lib/web-session"')) gate = "session?";
  const roleCheck = /role !== "admin"|role === "admin"/.test(s);
  const fence = s.includes("getAllowedFileRootsForRequest");
  const owner = s.includes("getOwnedProject") || s.includes("ownerId");
  const csrf = s.includes("isApiRequestAllowed");
  rows.push({ api, methods, gate, roleCheck, fence, owner, csrf });
}
const groups = {};
for (const r of rows) (groups[r.gate] ??= []).push(r);
for (const [g, list] of Object.entries(groups)) {
  console.log(`\n===== ${g} (${list.length}) =====`);
  for (const r of list)
    console.log(
      `${r.api} [${r.methods}]${r.roleCheck ? " role!" : ""}${r.fence ? " fence" : ""}${r.csrf ? " csrf" : ""}`,
    );
}
console.log("\nTOTAL", rows.length);
