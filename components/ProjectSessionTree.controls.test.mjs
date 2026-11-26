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

test("flips project and Host directory menus upward near the viewport bottom", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]{0,500}?const overflow = rect\.bottom - \(window\.innerHeight - margin\)/);
  assert.match(source, /anchorY - overflow/);
  assert.match(source, /el\.style\.maxHeight/);
  assert.match(source, /window\.addEventListener\("resize", place\)/);
});

test("project-first supports three sort modes and drag ordering", () => {
  assert.match(source, /sortSessionFirst/);
  assert.match(source, /projectOrder/);
  assert.match(source, /draggable=\{sortMode === "project" && !projectPinned\}/);
  assert.match(source, /draggable=\{sortMode === "project" && !hostPinned\}/);
  assert.match(source, /reorderGroup\(draggedGroupKey, projectPinKey\(project\.id\)\)/);
  assert.match(source, /reorderGroup\(draggedGroupKey, key\)/);
});

test("project menu groups actions and exposes hints; Host dirs can always be renamed", () => {
  assert.match(source, /sessions\.menuGroupProject/);
  assert.match(source, /sessions\.menuGroupConfig/);
  assert.match(source, /sessions\.menuGroupSandbox/);
  assert.match(source, /sessions\.menuGroupMaintenance/);
  assert.match(source, /body: JSON\.stringify\(\{ cwd: root, name \}\)/);
});

function functionBody(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} not found`);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return source.slice(start, end);
}

test("project delete, rename and container binding surface server errors", () => {
  for (const [startMarker, endMarker] of [
    ["const remove = async (project: ProjectRecord)", "// Host 临时附件"],
    ["const renameProject = async (", "// 项目快照槽"],
    ["const setContainer = async (", "// 项目快照槽"],
  ]) {
    const body = functionBody(startMarker, endMarker);
    assert.match(body, /if \(!res\.ok\)/, `${startMarker} must check res.ok`);
    assert.match(body, /window\.alert\(data\.error \?\? t\("sessions\.operationFailedHttp"/);
    assert.doesNotMatch(body, /catch\(\(\) => \{\}\)/, `${startMarker} must not swallow fetch errors`);
  }
});

test("mode, count and pin badges explain themselves on hover", () => {
  assert.match(source, /sessions\.sessionCountHint/);
  assert.match(source, /sessions\.modeSandboxHint/);
  assert.match(source, /sessions\.modeSshHint/);
  assert.match(source, /sessions\.modeLocalHint/);
  assert.match(source, /sessions\.modeHostHint/);
  assert.match(source, /sessions\.projectPinnedHint/);
});

test("Host directory groups share the project sort order", () => {
  assert.match(source, /sortSidebarGroups\(entries, sortMode\)/);
  assert.match(source, /order: groupRenderOrder\.get\(project\.id\)/);
  assert.match(source, /order: groupRenderOrder\.get\(key\)/);
});

test("projection badges refresh on a timer and when the tab becomes visible", () => {
  assert.match(source, /setInterval\(refreshIfVisible, 60_000\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshIfVisible\)/);
  assert.match(source, /document\.visibilityState === "visible"/);
});
