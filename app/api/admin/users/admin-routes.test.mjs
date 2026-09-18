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
  // Every backend interaction targets the BFF proxy (list + create + reset +
  // patch + delete + approve/reject ride /api/admin/users — 6 call sites,
  // approve/reject share one).
  const targets = [...dialogSource.matchAll(/["'`](\/api\/admin\/users[^"'`]*)["'`]/g)].map((m) => m[1]);
  assert.ok(targets.length >= 6, `expected >=6 BFF call sites, found ${targets.length}`);
  // And no other absolute API paths are fetched.
  const allApiRefs = [...dialogSource.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)].map((m) => m[1]);
  for (const ref of allApiRefs) {
    assert.ok(ref.startsWith("/api/admin/users"), `unexpected API target: ${ref}`);
  }
});

test("reset-password flow enforces the 8-char policy client-side and reports session invalidation", async () => {
  assert.match(dialogSource, /resetPassword\.length < 8/);
  assert.match(dialogSource, /重置后该用户的所有会话与登录态立即失效/);
});

test("the legacy console stays available as a fallback link, not the primary entry", async () => {
  assert.match(dialogSource, /consoleUrl/);
  assert.match(dialogSource, /完整控制台/);
});
