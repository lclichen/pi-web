import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-upload-client.ts");
}

test("splits a chat drop into images, files and folders", async () => {
  const { splitDroppedItems } = await loadSubject();
  const photo = new File(["x"], "photo.png", { type: "image/png" });
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });
  const unknown = new File(["x"], "server.log", { type: "" });

  const split = splitDroppedItems([
    { kind: "file", file: photo },
    { kind: "folder", name: "assets" },
    { kind: "file", file: report },
    { kind: "file", file: unknown },
  ]);

  assert.deepEqual(split.images, [photo]);
  assert.deepEqual(split.files, [report, unknown]);
  assert.deepEqual(split.folders, ["assets"]);
});

test("mentions uploaded files in drop order and quotes names with spaces", async () => {
  const { dropMentionText, mentionText } = await loadSubject();
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });
  const spaced = new File(["x"], "my notes.md", { type: "text/markdown" });

  assert.equal(dropMentionText([report, spaced], ["report.pdf", "my notes.md"]), '@report.pdf @"my notes.md" ');
  // A skipped name still gets a mention: it points at the existing file.
  assert.equal(dropMentionText([report, spaced], ["report.pdf"]), "@report.pdf ");
  assert.equal(mentionText([".pi/attachments/a b.png"]), '@".pi/attachments/a b.png" ');
});

test("attachment names keep the extension, sanitize separators and stay unique", async () => {
  const { attachmentFileName } = await loadSubject();
  const stamp = Date.UTC(2026, 10, 13, 6, 5, 4);
  const png = attachmentFileName({ name: "../../shot one.png", type: "image/png" }, stamp, "abc123");
  const jpeg = attachmentFileName({ name: "no-extension", type: "image/jpeg" }, stamp, "def456");

  assert.match(png, /^\d{8}-\d{6}-abc123-shot one\.png$/);
  assert.match(jpeg, /^\d{8}-\d{6}-def456-no-extension\.jpg$/);
  assert.notEqual(png, attachmentFileName({ name: "../../shot one.png", type: "image/png" }, stamp, "zzz999"));
});

test("attachment target joins the runtime folder under the upload root", async () => {
  const { ATTACHMENTS_DIR, attachmentsTarget } = await loadSubject();

  assert.equal(ATTACHMENTS_DIR, ".pi/attachments");
  assert.deepEqual(attachmentsTarget({ directory: "/home/user/project" }), {
    directory: "/home/user/project/.pi/attachments",
  });
  assert.deepEqual(attachmentsTarget({ directory: "/", sessionId: "s1" }), {
    directory: "/.pi/attachments",
    sessionId: "s1",
  });
});

test("uploads name each part and switch endpoints for remote sessions", async () => {
  const { uploadFiles } = await loadSubject();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ uploaded: ["a.png"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const file = new File(["x"], "a.png", { type: "image/png" });
    const host = await uploadFiles({ directory: "/project" }, [file], "skip", ["renamed.png"]);
    assert.equal(host.status, 200);
    assert.deepEqual(host.data, { uploaded: ["a.png"] });
    assert.equal(calls[0].url, "/api/files/project?type=upload&conflict=skip");
    assert.equal(calls[0].init.body.get("files").name, "renamed.png");

    await uploadFiles({ directory: "/", sessionId: "sess-1" }, [file], "skip");
    assert.equal(calls[1].url, "/api/remotefs/?src=sess-1&type=upload&conflict=skip");

    await uploadFiles({ directory: "/", sessionId: "sess-1" }, [file], "skip", undefined, { hostCache: true });
    assert.equal(calls[2].url, "/api/remotefs/?src=sess-1&type=upload&conflict=skip&hostCache=1");

    // A host target has no separate primary store — the workspace IS the Host.
    await uploadFiles({ directory: "/project" }, [file], "skip", undefined, { hostCache: true });
    assert.equal(calls[3].url, "/api/files/project?type=upload&conflict=skip");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
