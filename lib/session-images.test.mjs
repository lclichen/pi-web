import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-session-images-"));
process.env.PI_WEB_DATA_DIR = root;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  copySessionImages,
  deleteSessionImages,
  inlineMcpImageMarkers,
  readSessionImage,
  sessionImageIdForBase64,
  storeSessionImage,
  projectToolResultContentForClient,
  projectToolResultMessageForClient,
} = await jiti.import("./session-images.ts");

const PNG = "QUJD";

test.after(() => rmSync(root, { recursive: true, force: true }));

test("stores images content-addressed and reads them back", () => {
  const id = sessionImageIdForBase64(PNG);
  const meta = storeSessionImage("session-1", PNG, "image/png", { alt: "shot" });
  assert.deepEqual(meta && { ...meta, createdAt: undefined }, {
    id,
    mimeType: "image/png",
    bytes: 3,
    alt: "shot",
    createdAt: undefined,
  });

  const stored = readSessionImage("session-1", id);
  assert.ok(stored);
  assert.equal(stored.meta.mimeType, "image/png");
  assert.equal(readFileSync(stored.path).toString("base64"), PNG);
  assert.equal(stored.size, 3);

  // Same content reuses the same file; a different session gets its own dir.
  const again = storeSessionImage("session-1", PNG, "image/jpg", { id });
  assert.equal(again?.id, id);
  assert.equal(again?.mimeType, "image/jpeg");
  assert.ok(readSessionImage("session-1", id));
  assert.equal(readSessionImage("session-2", id), null);
});

test("rejects unsupported MIME/types and unknown ids", () => {
  assert.equal(storeSessionImage("session-1", PNG, "image/svg+xml"), null);
  assert.equal(storeSessionImage("session-1", "not base64!", "image/png"), null);
  assert.equal(readSessionImage("session-1", "img_deadbeefdeadbeef"), null);
  assert.equal(readSessionImage("session-1", "../etc/passwd"), null);
});

test("projects live content images to same-origin URLs without mutating input", () => {
  const content = [
    { type: "text", text: "before" },
    { type: "image", data: PNG, mimeType: "image/png" },
  ];
  const projected = projectToolResultContentForClient("session-1", content, {
    mcpImages: [{ id: sessionImageIdForBase64(PNG), alt: "架构图" }],
  });

  assert.equal(projected.changed, true);
  assert.deepEqual(projected.content[0], { type: "text", text: "before" });
  assert.deepEqual(projected.content[1], {
    type: "image",
    source: {
      type: "url",
      media_type: "image/png",
      url: `/api/sessions/session-1/images/${sessionImageIdForBase64(PNG)}`,
    },
  });
  assert.deepEqual(content[1], { type: "image", data: PNG, mimeType: "image/png" });

  // Already-projected URL blocks stay as they are.
  const unchanged = projectToolResultContentForClient("session-1", [
    { type: "image", source: { type: "url", url: "/api/x" } },
  ]);
  assert.equal(unchanged.changed, false);
});

test("projects a toolResult message and preserves non-tool messages", () => {
  const message = {
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "image", data: PNG, mimeType: "image/png" }],
  };
  const projected = projectToolResultMessageForClient("session-1", message);
  assert.notEqual(projected, message);
  assert.equal(projected.content[0].type, "image");
  assert.equal(projected.content[0].source.type, "url");

  const assistant = { role: "assistant", content: [] };
  assert.equal(projectToolResultMessageForClient("session-1", assistant), assistant);
});

test("inlines markers into exported HTML and reports missing images", () => {
  const id = sessionImageIdForBase64(PNG);
  storeSessionImage("session-1", PNG, "image/png", { id });
  const html = `<p>[[image:${id}|图]]</p><p>[[image:img_deadbeefdeadbeef|丢失]]</p>`;
  const inlined = inlineMcpImageMarkers(html, "session-1");
  assert.match(inlined, new RegExp(`<img src="data:image/png;base64,${PNG}" alt="图"`));
  assert.match(inlined, /丢失/);
  assert.doesNotMatch(inlined, /\[\[image:/);
});

test("deletes a session's image directory", () => {
  const id = sessionImageIdForBase64("REVG");
  storeSessionImage("session-delete", "REVG", "image/png", { id });
  assert.ok(readSessionImage("session-delete", id));
  deleteSessionImages("session-delete");
  assert.equal(readSessionImage("session-delete", id), null);
  assert.equal(
    existsSync(join(root, "session-images", "session-delete")),
    false,
  );
});

test("fork/clone asset copy keeps markers working in the child session", () => {
  const id = sessionImageIdForBase64("Rk9SSw==");
  storeSessionImage("session-parent", "Rk9SSw==", "image/png", { id });
  copySessionImages("session-parent", "session-child");
  assert.ok(readSessionImage("session-child", id));
  deleteSessionImages("session-parent");
  assert.ok(readSessionImage("session-child", id));
});
