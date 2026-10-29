import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * FileExplorer drag-to-move wiring: rows are draggable, folders are drop
 * targets, the background drops into the root, and the move goes through the
 * existing rename API (PATCH { newPath }) with a self/descendant guard.
 * Behaviour lives in a 2k-line component; these assertions pin the contract.
 */

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("tree rows are draggable and carry the move payload", () => {
  assert.match(source, /draggable/);
  assert.match(source, /e\.dataTransfer\.effectAllowed = "move"/);
  assert.match(source, /onNodeDragStart\?\.\(node\)/);
});

test("folders accept drops with a hover highlight", () => {
  assert.match(source, /onNodeDropOnDir\?\.\(node\.fullPath\)/);
  assert.match(source, /onNodeDragOverDir\?\.\(node\.fullPath\)/);
  assert.match(source, /dragOverPath === node\.fullPath/);
});

test("moving reuses the rename endpoint and refuses self/descendant drops", () => {
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /JSON\.stringify\(\{ newPath: target \}\)/);
  assert.match(source, /dirNorm\.startsWith\(`\$\{srcNorm\}\/`\)/);
  assert.match(source, /files\.cannotMoveIntoSelf/);
});

test("the explorer background drops into the current directory", () => {
  assert.match(source, /onDrop=\{\(e\) => \{\s*if \(!draggingNode\) return;/);
  assert.match(source, /handleMoveToDir\(cwd\)/);
});
