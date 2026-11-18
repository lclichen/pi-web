import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CASES = [
  { name: "side rail", width: 320, height: 800 },
  { name: "bottom bar", width: 1000, height: 260 },
  { name: "mini", width: 360, height: 220 },
  { name: "full", width: 900, height: 700 },
];

const PRODUCT_ID = "e2e";
const PRODUCT_NAME = "E2E Product";

function parentPage() {
  return `<!doctype html><html><body style="margin:0;background:#d8dde7">
<iframe id="embed" title="Agent" style="display:block;border:0;width:900px;height:700px"></iframe>
<script>
const params = new URLSearchParams(location.search);
const frame = document.getElementById("embed");
frame.style.width = (params.get("w") || "900") + "px";
frame.style.height = (params.get("h") || "700") + "px";
frame.src = params.get("src") || "";
</script></body></html>`;
}

function writeSession(agentDir, id, cwd, name, text) {
  const header = { type: "session", version: 3, id, timestamp: "2026-11-18T00:00:00.000Z", cwd };
  const info = {
    type: "session_info",
    id: `${id}-name`,
    parentId: null,
    timestamp: "2026-11-18T00:00:00.500Z",
    name,
  };
  const message = {
    type: "message",
    id: `${id}-m1`,
    parentId: `${id}-name`,
    timestamp: "2026-11-18T00:00:01.000Z",
    message: { role: "user", content: text },
  };
  writeFileSync(
    join(agentDir, "sessions", "e2e", `${id}.jsonl`),
    [header, info, message].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

function recordProjectSession(agentDir, id, projectId) {
  const path = join(agentDir, "data", "session-metas.json");
  let data = { version: 1, sessions: {} };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // fresh data dir
  }
  data.sessions[id] = { mode: "sandbox", ownerId: 0, projectId, createdAt: Date.now() };
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Product integration gate: configure a product, create/reuse a stable project
 * through the product API, open it with a short-lived access token, and exercise
 * the same session UI at four container sizes.
 */
export async function checkEmbed({ browser, base, agentDir }) {
  const profiles = await fetch(`${base}/api/admin/embed-profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      products: [
        {
          id: PRODUCT_ID,
          name: PRODUCT_NAME,
          allowedCommands: ["compact", "name", "copy"],
          allowedOrigins: [],
          enabled: true,
          configBundle: null,
          defaultMode: "sandbox",
        },
      ],
    }),
  });
  assert.equal(profiles.status, 200, await profiles.clone().text());

  const preflight = await fetch(`${base}/api/embed/products/${PRODUCT_ID}/projects`, {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.com" },
  });
  assert.equal(preflight.status, 204, "product API CORS preflight");
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  const created = await fetch(`${base}/api/embed/products/${PRODUCT_ID}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "e2e-client",
      externalRef: "default",
      mode: "sandbox",
      name: "E2E Embedded Project",
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const project = await created.json();
  const projectId = project.project.id;
  const projectHome = join(agentDir, "data", "sandbox-homes", "u0", projectId);
  mkdirSync(projectHome, { recursive: true });
  writeSession(agentDir, "embed-session-a", projectHome, "Session A", "hello session-a");
  writeSession(agentDir, "embed-session-b", projectHome, "Session B", "hello session-b");
  recordProjectSession(agentDir, "embed-session-a", projectId);
  recordProjectSession(agentDir, "embed-session-b", projectId);
  const refreshed = await fetch(`${base}/api/sessions?force=1`);
  assert.equal(refreshed.status, 200);

  const opened = await fetch(`${base}/api/embed/products/${PRODUCT_ID}/projects/${projectId}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(opened.status, 200, await opened.clone().text());
  const openBody = await opened.json();
  assert.match(openBody.url, /#token=emba_/);
  const embedUrl = openBody.url;

  const parent = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(parentPage());
  });
  parent.listen(0, "127.0.0.1");
  await once(parent, "listening");
  const parentBase = `http://127.0.0.1:${parent.address().port}`;

  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => {
    if (event.type() === "error") errors.push(event.text());
  });

  try {
    for (const testCase of CASES) {
      const url = `${parentBase}/?w=${testCase.width}&h=${testCase.height}&src=${encodeURIComponent(embedUrl)}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const iframe = page.locator("#embed");
      const handle = await iframe.elementHandle();
      const frame = await handle.contentFrame();
      await frame.waitForSelector(".embed-shell", { timeout: 30_000 });
      await frame.getByRole("button", { name: "Sessions", exact: true }).waitFor();
      assert.equal(await frame.locator("#session-sidebar").count(), 0, `${testCase.name}: no AppShell sidebar`);
      assert.equal(await frame.getByText("Projects", { exact: true }).count(), 0, `${testCase.name}: no project switch`);

      const listButton = frame.getByRole("button", { name: "Sessions", exact: true });
      const popover = frame.locator(".embed-sessions-popover");
      await listButton.click();
      await frame.waitForTimeout(100);
      if (!(await popover.isVisible().catch(() => false))) await listButton.click();
      await popover.waitFor();
      const iframeBox = await iframe.boundingBox();
      const popoverBox = await popover.boundingBox();
      assert.ok(iframeBox && popoverBox, `${testCase.name}: popover measured`);
      assert.ok(
        popoverBox.x >= iframeBox.x - 1 &&
          popoverBox.x + popoverBox.width <= iframeBox.x + iframeBox.width + 1 &&
          popoverBox.y >= iframeBox.y - 1 &&
          popoverBox.y + popoverBox.height <= iframeBox.y + iframeBox.height + 1,
        `${testCase.name}: session popover must stay inside the iframe`,
      );

      await frame.locator(".embed-session-row", { hasText: "Session A" }).click();
      await popover.waitFor({ state: "detached" });
      await frame.locator("[data-entry-id]").getByText("hello session-a", { exact: true }).first().waitFor({ timeout: 30_000 });

      const metrics = await frame.evaluate(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        chat: document.querySelector(".chat-content")?.getBoundingClientRect().height ?? 0,
      }));
      assert.ok(metrics.scrollWidth <= metrics.width, `${testCase.name}: no horizontal overflow`);
      assert.ok(metrics.chat > 0, `${testCase.name}: chat area has height`);

      const composer = frame.locator("textarea.chat-input-textarea").first();
      await composer.waitFor();
      const composerBox = await composer.boundingBox();
      assert.ok(composerBox, `${testCase.name}: composer exists`);
      assert.ok(
        composerBox.y >= iframeBox.y - 1 && composerBox.y + composerBox.height <= iframeBox.y + iframeBox.height + 1,
        `${testCase.name}: composer must stay inside the iframe`,
      );

      await frame.getByRole("button", { name: "New chat", exact: true }).click();
      await frame.getByRole("button", { name: "New chat", exact: true }).waitFor();
      const newComposer = frame.locator("textarea.chat-input-textarea").first();
      await newComposer.waitFor();
      const newBox = await newComposer.boundingBox();
      assert.ok(
        newBox && newBox.y + newBox.height <= iframeBox.y + iframeBox.height + 1,
        `${testCase.name}: new-chat composer must stay inside the iframe`,
      );
      console.log(`PASS: embed ${testCase.name} (${testCase.width}x${testCase.height})`);
    }

    // Exercise session actions once in the full layout.
    const iframe = page.locator("#embed");
    const handle = await iframe.elementHandle();
    const frame = await handle.contentFrame();
    await frame.getByRole("button", { name: "Sessions", exact: true }).click();
    const row = frame.locator(".embed-session-row-wrap", { hasText: "Session A" });
    await row.getByRole("button", { name: "Session actions" }).click();
    await frame.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = frame.getByRole("textbox", { name: "Rename" });
    await renameInput.fill("Renamed A");
    await frame.getByRole("button", { name: "Save" }).click();
    await frame.getByText("Renamed A", { exact: true }).waitFor();
    const renamedRow = frame.locator(".embed-session-row-wrap", { hasText: "Renamed A" });
    await renamedRow.getByRole("button", { name: "Session actions" }).click();
    await frame.getByRole("menuitem", { name: "Archive" }).click();
    await frame.getByRole("button", { name: "Show archived" }).click();
    await frame.getByText("Archived", { exact: true }).waitFor();
    const archivedRow = frame.locator(".embed-session-row-wrap", { hasText: "Renamed A" });
    await archivedRow.getByRole("button", { name: "Session actions" }).click();
    await frame.getByRole("menuitem", { name: "Delete" }).click();
    await frame.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await frame.getByText("Renamed A", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(errors, [], "embed browser errors");
  } finally {
    await context.close();
    parent.close();
  }
}
