import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const CASES = [
  { name: "side rail", width: 320, height: 800 },
  { name: "bottom bar", width: 1000, height: 260 },
  { name: "mini", width: 360, height: 220 },
  { name: "full", width: 900, height: 700 },
];

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

/**
 * Opens the embed page inside a cross-origin parent at four container sizes.
 * This is the layout gate for side rails, bottom bars, mini cards, and full
 * page embeds, and also proves that no pi-web cookie is involved.
 */
export async function checkEmbed({ browser, base, project }) {
  const created = await fetch(`${base}/api/embed/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project, productId: "default", ttlMinutes: 60, label: "E2E Embed" }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const tokenData = await created.json();
  const embedUrl = tokenData.url;
  const rawToken = embedUrl.split("/embed/")[1];
  assert.match(rawToken, /^emb_/);

  const sessionList = await fetch(`${base}/api/sessions`, {
    headers: { Authorization: `Bearer ${rawToken}` },
  });
  assert.equal(sessionList.status, 200, "embed token must authenticate without a cookie");

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
      if (!(await popover.isVisible().catch(() => false))) {
        // A frame that is still settling can drop the first click; retry once.
        await listButton.click();
      }
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

      await frame.getByRole("button", { name: /E2E message 0000/ }).click();
      await popover.waitFor({ state: "detached" });
      await frame.getByText("E2E message 4999", { exact: true }).waitFor({ timeout: 30_000 });

      const metrics = await frame.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
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
    assert.deepEqual(errors, [], "embed browser errors");
  } finally {
    await context.close();
    parent.close();
    await fetch(`${base}/api/embed/tokens/${encodeURIComponent(tokenData.id)}`, { method: "DELETE" }).catch(() => {});
  }
}
