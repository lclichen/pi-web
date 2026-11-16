import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("logout tears down the browser push subscription", async () => {
  const client = await read("./push-client.ts");
  assert.match(client, /export async function teardownPushSubscription/);
  assert.match(client, /method: "DELETE"/);
  assert.match(client, /subscription\.unsubscribe\(\)/);

  const settings = await read("../components/AccountSettings.tsx");
  assert.match(settings, /await teardownPushSubscription\(\)[\s\S]*?webauth\/logout/);
  const shell = await read("../components/AppShell.tsx");
  assert.match(shell, /await teardownPushSubscription\(\)[\s\S]*?webauth\/logout/);
});

test("a push endpoint is claimed by one user and removable by that user", async () => {
  const store = await read("./web-push.ts");
  assert.match(store, /removeEndpointFromOtherUsers\(subscription\.endpoint, userId\)/);
  assert.match(store, /removeSubscription\(endpoint, userId = 0\)/);

  const route = await read("../app/api/push/subscribe/route.ts");
  assert.match(route, /export async function DELETE/);
  assert.match(route, /removePushSubscription\(endpoint, identity\.session\.user\.id\)/);
});

test("the service worker checks the signed-in owner before showing a push", async () => {
  const sw = await read("../public/sw.js");
  assert.match(sw, /typeof ownerId === "number" && ownerId > 0/);
  assert.match(sw, /fetch\("\/api\/webauth\/me"/);
  assert.match(sw, /if \(current !== ownerId\) return/);
});
