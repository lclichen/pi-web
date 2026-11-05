import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { appendGuardrailAudit, GUARDRAIL_AUDIT_FILE, GUARDRAIL_AUDIT_MAX_BYTES } = await jiti.import(
  "../pi-config/agent/extensions/amedac-core/src/guardrail-audit.ts",
);

/**
 * P2c 护栏审计：每次判定一行 JSONL；超 2MB 轮转为 .1；任何 IO 失败静默。
 */

function entry(overrides = {}) {
  return { ts: 1000, tool: "bash", path: "/srv/x", action: "deny", via: "rule", ...overrides };
}

test("appends one JSON line per verdict (no history rewritten)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "audit-"));
  try {
    appendGuardrailAudit(cwd, entry());
    appendGuardrailAudit(cwd, entry({ tool: "write", action: "ask", via: "ask" }));
    const lines = readFileSync(join(cwd, GUARDRAIL_AUDIT_FILE), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), entry());
    assert.equal(JSON.parse(lines[1]).tool, "write");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rotates to .1 once the file exceeds the cap (single previous generation)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "audit-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, GUARDRAIL_AUDIT_FILE), "x".repeat(GUARDRAIL_AUDIT_MAX_BYTES + 10));
    appendGuardrailAudit(cwd, entry());
    assert.ok(existsSync(join(cwd, `${GUARDRAIL_AUDIT_FILE}.1`)), "旧文件轮转到 .1");
    const fresh = readFileSync(join(cwd, GUARDRAIL_AUDIT_FILE), "utf8").trim();
    assert.equal(fresh.split("\n").length, 1, "新文件只含本次判定");
    assert.equal(JSON.parse(fresh).tool, "bash");
    // 再次满额：覆盖上一代 .1（不堆积）。
    writeFileSync(join(cwd, GUARDRAIL_AUDIT_FILE), "y".repeat(GUARDRAIL_AUDIT_MAX_BYTES + 10));
    appendGuardrailAudit(cwd, entry({ tool: "read" }));
    assert.equal(readFileSync(join(cwd, `${GUARDRAIL_AUDIT_FILE}.1`), "utf8").slice(0, 1), "y");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("audit failures never throw (read-only cwd)", () => {
  // 指向一个不存在且无法创建的路径（父层级是文件）。
  const cwd = mkdtempSync(join(tmpdir(), "audit-"));
  try {
    const blocker = join(cwd, "blocked");
    writeFileSync(blocker, "x");
    assert.doesNotThrow(() => appendGuardrailAudit(blocker, entry()));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
