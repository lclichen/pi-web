import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./session-plan.ts");
}

function tempProject() {
  return mkdtempSync(join(tmpdir(), "pi-web-plan-test-"));
}

test("saveSessionPlan writes the per-session file, creating .pi/plans", async () => {
  const { saveSessionPlan, sessionPlanPath, PLAN_DIR_NAME } = await loadSubject();
  const cwd = tempProject();
  try {
    const result = saveSessionPlan(cwd, "sess-1", "# 计划\n\n- [ ] 步骤");
    assert.equal(result.ok, true);
    const path = sessionPlanPath(cwd, "sess-1");
    // Separator-agnostic: path.join uses "\" on Windows.
    const expectedSuffix = ["pi-web-plan", ".pi", "plans", "plan-sess_sess-1.md"];
    assert.ok(PLAN_DIR_NAME.replace("/", "-sep-") === ".pi-sep-plans");
    assert.equal(
      path.split(/[\\/]/).slice(-expectedSuffix.length + 1).join("/"),
      expectedSuffix.slice(1).join("/"),
      `unexpected plan path: ${path}`,
    );
    assert.equal(readFileSync(path, "utf8"), "# 计划\n\n- [ ] 步骤\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveSessionPlan overwrites and never appends", async () => {
  const { saveSessionPlan, sessionPlanPath } = await loadSubject();
  const cwd = tempProject();
  try {
    saveSessionPlan(cwd, "s", "first");
    saveSessionPlan(cwd, "s", "second");
    assert.equal(readFileSync(sessionPlanPath(cwd, "s"), "utf8"), "second\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveSessionPlan reports failures instead of throwing", async () => {
  const { saveSessionPlan } = await loadSubject();
  // A file occupying the .pi/plans directory path makes the write fail.
  const cwd = tempProject();
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "plans"), "not a directory");
    const result = saveSessionPlan(cwd, "s", "content");
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
    // The blocking file is untouched — no partial write.
    assert.equal(readFileSync(join(cwd, ".pi", "plans"), "utf8"), "not a directory");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isPlanProfile matches plan-ish subagent profiles only", async () => {
  const { isPlanProfile } = await loadSubject();
  for (const hit of ["plan", "Plan", "PLANNER", "planning", "architect", " Plan "]) {
    assert.equal(isPlanProfile(hit), true, hit);
  }
  for (const miss of ["general-purpose", "code-reviewer", "playwright", undefined, ""]) {
    assert.equal(isPlanProfile(miss), false, String(miss));
  }
});
