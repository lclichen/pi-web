import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProjectSessionTree.tsx", import.meta.url), "utf8");

test("uses the ZCode-style collapse/expand and filter icons", () => {
  assert.match(source, /import \{ ListChevronsDownUp, ListChevronsUpDown, ListFilter, Pin \} from "lucide-react"/);
  assert.match(source, /anyGroupExpanded \? <ListChevronsDownUp/);
  assert.match(source, /<ListChevronsUpDown/);
  assert.match(source, /<ListFilter/);
});

test("exposes collapse-all, sort and unread filter labels", () => {
  assert.match(source, /sessions\.collapseAllProjects/);
  assert.match(source, /sessions\.expandAllProjects/);
  assert.match(source, /sessions\.sortProjectFirst/);
  assert.match(source, /sessions\.sortConnectionFirst/);
  assert.match(source, /sessions\.unreadOnly/);
});

test("renders a pinned section and pins sessions through the sidebar API", () => {
  assert.match(source, /sessions\.pinned/);
  assert.match(source, /renderItem\(s\)/);
  assert.match(source, /toggleSessionPin/);
  assert.match(source, /<Pin size=\{12\} fill="currentColor" \/>/);
});

test("pins projects from both the project and Host directory menus", () => {
  assert.match(source, /sessions\.pinProject/);
  assert.match(source, /sessions\.unpinProject/);
  assert.match(source, /hostPinKey/);
  assert.match(source, /projectPinKey/);
});

test("Host directory groups share the project sort order", () => {
  assert.match(source, /sortSidebarGroups\(entries, sortMode\)/);
  assert.match(source, /order: groupRenderOrder\.get\(project\.id\)/);
  assert.match(source, /order: groupRenderOrder\.get\(key\)/);
});
