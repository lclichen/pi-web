import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./chat-attachments.ts");
}

function harness(options = {}) {
  const calls = { ensure: [], uploads: [], mentions: [], notices: [], refreshed: 0 };
  const api = {
    ensureUploadDirectory: async (target) => {
      calls.ensure.push(target);
      return true;
    },
    uploadFiles: async (target, files, strategy, names, uploadOptions) => {
      const effective = names ?? files.map((file) => file.name);
      calls.uploads.push({ target, names: effective, strategy, options: uploadOptions });
      return options.respond ? options.respond(target, files, names) : { status: 200, data: { uploaded: effective } };
    },
  };
  const hooks = {
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    insertText: (text) => calls.mentions.push(text),
    onUploaded: () => {
      calls.refreshed += 1;
    },
  };
  return { calls, api, hooks };
}

test("host files upload into the working directory and are mentioned", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness();
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });

  await uploadChatAttachments({ directory: "/project" }, [report], [], hooks, api);

  assert.deepEqual(calls.uploads, [
    { target: { directory: "/project" }, names: ["report.pdf"], strategy: "skip", options: { hostCache: false } },
  ]);
  assert.deepEqual(calls.mentions, ["@report.pdf "]);
  assert.deepEqual(calls.notices, [["success", 'chat.dropUploaded {"count":1}']]);
  assert.equal(calls.refreshed, 1);
  assert.equal(calls.ensure.length, 0, "no attachment dir for a files-only upload");
});

test("host images are stored under .pi/attachments and mentioned for tools/MCP", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness();
  const photo = new File(["x"], "photo.png", { type: "image/png" });

  await uploadChatAttachments({ directory: "/project" }, [], [photo], hooks, api);

  assert.deepEqual(calls.ensure, [{ directory: "/project/.pi/attachments" }]);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].target.directory, "/project/.pi/attachments");
  assert.equal(calls.uploads[0].strategy, "skip");
  assert.match(calls.uploads[0].names[0], /^\d{8}-\d{6}-[a-z0-9]+-photo\.png$/);
  assert.match(calls.mentions[0], /^@\.pi\/attachments\/\d{8}-\d{6}-[a-z0-9]+-photo\.png $/);
  assert.equal(calls.refreshed, 1);
});

test("mixed drops upload both kinds and mention files first", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness();
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });
  const photo = new File(["x"], "photo.jpg", { type: "image/jpeg" });

  await uploadChatAttachments({ directory: "/project" }, [report], [photo], hooks, api);

  assert.equal(calls.uploads.length, 2);
  assert.equal(calls.mentions.length, 1);
  assert.match(calls.mentions[0], /^@report\.pdf @\.pi\/attachments\/\d{8}-\d{6}-[a-z0-9]+-photo\.jpg $/);
});

test("remote sessions store files and images on the Host and mirror them remotely", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness();
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });
  const photo = new File(["x"], "photo.png", { type: "image/png" });

  await uploadChatAttachments({ directory: "/", sessionId: "sess-1" }, [report], [photo], hooks, api);

  assert.equal(calls.uploads.length, 2);
  assert.deepEqual(calls.uploads[0].target, { directory: "/", sessionId: "sess-1" });
  assert.deepEqual(calls.uploads[0].options, { hostCache: true });
  assert.deepEqual(calls.uploads[1].target, { directory: "/.pi/attachments", sessionId: "sess-1" });
  assert.deepEqual(calls.uploads[1].options, { hostCache: true });
  assert.equal(calls.ensure.length, 1, "the remote attachment dir is created before the image upload");
  assert.deepEqual(calls.mentions.length, 1);
  assert.match(calls.mentions[0], /^@report\.pdf @\.pi\/attachments\/\d{8}-\d{6}-[a-z0-9]+-photo\.png $/);
});

test("a skipped name is still mentioned and reported", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness({
    respond: () => ({ status: 200, data: { uploaded: [], skipped: ["report.pdf"] } }),
  });

  await uploadChatAttachments({ directory: "/project" }, [new File(["x"], "report.pdf", { type: "application/pdf" })], [], hooks, api);

  assert.deepEqual(calls.mentions, ["@report.pdf "]);
  assert.deepEqual(calls.notices, [["warning", 'chat.dropAlreadyExists {"names":"report.pdf"}']]);
  assert.equal(calls.refreshed, 0);
});

test("upload failures surface a notice instead of failing silently", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness({
    respond: () => ({ status: 403, data: { error: "Access denied" } }),
  });

  await uploadChatAttachments({ directory: "/project" }, [new File(["x"], "a.txt", { type: "text/plain" })], [], hooks, api);

  assert.deepEqual(calls.mentions, []);
  assert.deepEqual(calls.notices, [["error", "chat.dropFailed {\"message\":\"Access denied\"}"]]);
});

test("an image store failure keeps the inline image and reports the path problem", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness();
  api.ensureUploadDirectory = async () => false;

  await uploadChatAttachments({ directory: "/project" }, [], [new File(["x"], "photo.png", { type: "image/png" })], hooks, api);

  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.mentions, []);
  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0][0], "error");
  assert.match(calls.notices[0][1], /Cannot create \.pi\/attachments/);
});

test("a Host-only image is not mentioned: the remote path is not readable there", async () => {
  const { uploadChatAttachments } = await loadSubject();
  const { calls, api, hooks } = harness({
    respond: () => ({
      status: 200,
      data: {
        uploaded: [],
        skipped: [],
        hostOnly: ["20261113-120000-abc123-photo.png"],
        hostDir: "/data/local-homes/u1/proj/.pi/attachments",
        warning: "本机 Agent 版本过旧（0.5.0），无法写入二进制文件",
      },
    }),
  });

  await uploadChatAttachments({ directory: "/", sessionId: "sess-1" }, [], [new File(["x"], "photo.png", { type: "image/png" })], hooks, api);

  assert.deepEqual(calls.mentions, [], "no dangling @ path for a file the remote cannot read");
  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0][0], "warning");
  assert.match(calls.notices[0][1], /chat\.dropHostOnly/);
  assert.match(calls.notices[0][1], /20261113-120000-abc123-photo\.png/);
  assert.match(calls.notices[0][1], /local-homes\/u1\/proj/);
});
