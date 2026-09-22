import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { WEB_UI_SYSTEM_PROMPT_ADDENDUM, appendWebUiAddendum } from "./web-system-prompt.ts";

test("the addendum teaches image markdown without code fences", () => {
  // The renderer only turns real markdown into <img>; fenced or backticked
  // image syntax displays as literal source. The addendum must say both sides.
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /!\[[^\]]*\]\([^)]+\)/);
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /code fence/i);
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /relative to the current working directory/i);
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /http\(s\) URL/i);
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /%20/);
  // PDF page fragments pair with the #page= viewer support (5e9b997).
  assert.match(WEB_UI_SYSTEM_PROMPT_ADDENDUM, /#page=\d+/);
});

test("appendWebUiAddendum appends once and stays idempotent", () => {
  const base = "You are a coding agent.";
  const once = appendWebUiAddendum(base);
  assert.equal(once, `${base}\n\n${WEB_UI_SYSTEM_PROMPT_ADDENDUM}`);
  assert.equal(appendWebUiAddendum(once), once);
  // Already appended: the input is returned untouched (trailing space included).
  assert.equal(appendWebUiAddendum(`${once}\n\n`), `${once}\n\n`);
});

test("appendWebUiAddendum never invents a prompt for forced-empty sessions", () => {
  assert.equal(appendWebUiAddendum(""), "");
  assert.equal(appendWebUiAddendum("   \n\t"), "   \n\t");
});

test("rpc-manager wires the addendum for regular sessions only", () => {
  // Source-level assertion (the wrapper needs a live agent session):
  // the continuation must be installed after the exact-prompt continuation
  // (so it appends last), mirrored into the display state, and enabled only
  // for non-quick, non-subagent sessions.
  const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // The exact-prompt continuation is installed first, so the web addendum
  // wraps it and appends to the final prompt.
  const installOrder = source.indexOf("this.installWebUiAddendumContinuation();")
    - source.indexOf("this.installExactSystemPromptContinuation();");
  assert.ok(installOrder > 0, "web addendum continuation must be installed after the exact-prompt continuation");
  assert.match(source, /webUiPrompt: !subagentResources && !quick/);
  assert.match(source, /private applyWebUiAddendumToState\(\): void/);
  assert.match(source, /if \(this\.forceEmptySystemPrompt\) return prepared;/);
});
