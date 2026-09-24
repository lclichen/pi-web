import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Contract assertions for the admin BFF proxy + panel (source-level, the
 *  established pattern for app/api tests in this repo). */

const usersRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const idRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const passwordRoute = await readFile(new URL("./[id]/password/route.ts", import.meta.url), "utf8");
const approveRoute = await readFile(new URL("./[id]/approve/route.ts", import.meta.url), "utf8");
const dialogSource = await readFile(
  new URL("../../../../components/PlatformAdminDialog.tsx", import.meta.url),
  "utf8",
);

test("every admin route gates on requireAdminIdentity before any platform call", async () => {
  const firstCall = (src, ...markers) =>
    Math.min(...markers.map((m) => src.indexOf(m)).filter((i) => i !== -1));
  for (const [name, src, callMarker] of [
    ["users", usersRoute, 'platformGet<unknown>("/api/v1/admin/users"'],
    ["users/[id]", idRoute, "platformPatch<unknown>("],
    ["users/[id]/password", passwordRoute, "platformPost<void>("],
    ["users/[id]/approve", approveRoute, "platformPost<unknown>("],
  ]) {
    assert.ok(src.includes("requireAdminIdentity"), `${name}: uses the admin gate`);
    // Gate runs before the first platform CALL (ignore the import line).
    assert.ok(
      src.indexOf("requireAdminIdentity(req)") < firstCall(src, callMarker),
      `${name}: gate precedes platform forwarding`,
    );
  }
});

test("routes forward with the session's platform key, never a body-borne secret", async () => {
  assert.match(usersRoute, /platformGet<unknown>\("\/api\/v1\/admin\/users", identity\.session\.apiKey/);
  assert.match(passwordRoute, /identity\.session\.apiKey/);
  assert.match(idRoute, /platformPatch<unknown>\(`\/api\/v1\/admin\/users\/\$\{id\}`/);
});

test("user ids are numerically validated before hitting the platform", async () => {
  for (const src of [idRoute, passwordRoute, approveRoute]) {
    assert.match(src, /\/\^\\d\+\$\/\.test\(id\)/);
  }
});

test("the panel never touches platform URLs from the browser", async () => {
  assert.ok(!/PI_WEB_PLATFORM_URL|platformUrl\(\)/.test(dialogSource), "browser code must stay platform-agnostic");
  // Every backend interaction targets the BFF proxy across all three tabs
  // (users + containers + images: list/create/reset/patch/delete/lifecycle).
  const targets = [...dialogSource.matchAll(/["'`](\/api\/admin\/[a-z]+[^"'`]*)["'`]/g)].map((m) => m[1]);
  assert.ok(targets.length >= 12, `expected >=12 BFF call sites, found ${targets.length}`);
  // And no other absolute API paths are fetched.
  const allApiRefs = [...dialogSource.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)].map((m) => m[1]);
  for (const ref of allApiRefs) {
    assert.ok(ref.startsWith("/api/admin/"), `unexpected API target: ${ref}`);
  }
});

test("P2 tabs exist: containers lifecycle + image catalogue actions", async () => {
  assert.match(dialogSource, /"containers" \| "images"/);
  assert.match(dialogSource, /\/api\/admin\/containers\/\$\{row\.id\}\/\$\{act\}/);
  assert.match(dialogSource, /\/api\/admin\/containers\/\$\{row\.id\}`/);
  assert.match(dialogSource, /\/api\/admin\/images\/\$\{img\.id\}/);
  assert.match(dialogSource, /owner_username/);
});

test("reset-password flow enforces the 8-char policy client-side and reports session invalidation", async () => {
  assert.match(dialogSource, /resetPassword\.length < 8/);
  // Session-invalidation notice（原中文直键，2026-09 统一为英文键 admin.allUsersSessionsLoginsBecome）
  assert.match(dialogSource, /admin\.allUsersSessionsLoginsBecome/);
  const zh = await readFile(new URL("../../../../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
  assert.match(zh, /"admin\.allUsersSessionsLoginsBecome":\s*"重置后该用户的所有会话与登录态立即失效/);
});

test("the legacy external console link is fully retired", async () => {
  assert.ok(!/consoleUrl/.test(dialogSource), "no consoleUrl prop should remain");
  assert.ok(!/完整控制台/.test(dialogSource), "no fallback console link should remain");
  assert.ok(!/完整管理台/.test(dialogSource), "no legacy console mention should remain");
});

test("P3 tabs exist: overview/quotas/workspaces/llm/logs", async () => {
  assert.match(dialogSource, /"overview" \| "users" \| "containers" \| "images" \| "quotas" \| "workspaces" \| "llm" \| "logs"/);
  assert.match(dialogSource, /\/api\/admin\/overview/);
  assert.match(dialogSource, /\/api\/admin\/quotas/);
  assert.match(dialogSource, /\/api\/admin\/workspaces/);
  assert.match(dialogSource, /\/api\/admin\/llm\/bindings/);
  assert.match(dialogSource, /\/api\/admin\/logs/);
});
