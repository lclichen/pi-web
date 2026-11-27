import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { dropMentionText, splitDroppedItems } = await jiti.import("../lib/file-upload-client.ts");

const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Runs one of ChatWindow's useCallback bodies against the given scope. */
function chatWindowCallback(name, context) {
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log", { type: "" });

/** Picks files with the composer's attach button, through ChatWindow's real drop path. */
async function attach(files, { cwd = "/project" } = {}) {
  const calls = { images: [], uploads: [], mentions: [], notices: [] };
  const scope = {
    session: null,
    newSessionCwd: cwd,
    newSessionMode: "host",
    messageCwd: cwd ?? undefined,
    remoteFileSessionId: null,
    chatInputRef: {
      current: {
        addImages: (images) => calls.images.push(...images),
        insertText: (text) => calls.mentions.push(text),
      },
    },
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    splitDroppedItems,
    dropMentionText,
    uploadChatFiles: async (target, uploads, images) => {
      calls.uploads.push([target.directory, uploads.map((file) => file.name), images.map((file) => file.name)]);
    },
  };
  scope.onDrop = chatWindowCallback("onDrop", scope);
  chatWindowCallback("onAttachFiles", scope)(files);
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("the attach button sends picked files down the chat drop path (#1101)", async () => {
  const mixed = await attach([photo, report, log]);
  // Images attach to the prompt and are stored with the other files (so tools
  // can read them); nothing replaces an existing name.
  assert.deepEqual(mixed.images, [photo]);
  assert.deepEqual(mixed.uploads, [["/project", ["report.pdf", "server.log"], ["photo.png"]]]);
  assert.deepEqual(mixed.mentions, []);
  assert.deepEqual(mixed.notices, []);

  const imagesOnly = await attach([photo]);
  assert.deepEqual(imagesOnly.images, [photo]);
  assert.deepEqual(imagesOnly.uploads, [["/project", [], ["photo.png"]]]);
  assert.deepEqual(imagesOnly.notices, []);
});

test("without a working directory, picked files behave like a drop there (#1101)", async () => {
  const calls = await attach([photo, report], { cwd: null });
  assert.deepEqual(calls.images, [photo]);
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.notices, [["warning", "chat.dropNeedsCwd"]]);
});
