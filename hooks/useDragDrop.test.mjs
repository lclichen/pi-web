import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, { jsx: { runtime: "automatic" } }).import("./useDragDrop.ts");
}

function fileItem(name, type) {
  const file = new File(["x"], name, { type });
  return { kind: "file", type, webkitGetAsEntry: () => ({ isDirectory: false, name }), getAsFile: () => file };
}

test("a drop collects files of every type and keeps folders out as folders", async () => {
  const { droppedItems } = await loadSubject();
  const image = fileItem("photo.png", "image/png");
  const pdf = fileItem("report.pdf", "application/pdf");

  const items = droppedItems({
    items: [image, { kind: "string", type: "text/plain" }, pdf],
    files: [],
  });

  assert.deepEqual(
    items.map((item) => (item.kind === "file" ? item.file.name : `folder:${item.name}`)),
    ["photo.png", "report.pdf"],
    "non-file drag data is ignored, non-image files are included",
  );
});

test("a dropped folder is reported as a folder, not as a zero-byte file", async () => {
  const { droppedItems } = await loadSubject();

  const items = droppedItems({
    items: [{ kind: "file", type: "", webkitGetAsEntry: () => ({ isDirectory: true, name: "assets" }) }],
    files: [],
  });

  assert.deepEqual(items, [{ kind: "folder", name: "assets" }]);
});

test("falls back to dataTransfer.files when items are not exposed", async () => {
  const { droppedItems } = await loadSubject();
  const file = new File(["x"], "log.txt", { type: "text/plain" });

  const items = droppedItems({ items: [], files: [file] });

  assert.deepEqual(items, [{ kind: "file", file }]);
});
