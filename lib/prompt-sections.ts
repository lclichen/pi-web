/**
 * Shared system-prompt section surgery.
 *
 * pi's SDK builds the base prompt with two blocks that do not apply to every
 * pi-web session:
 *   · "Pi documentation (...)" — the pi SDK/extension docs index, ~180 tokens
 *     aimed at people developing ON pi. Quick sessions and remote workspace
 *     modes (sandbox / local-machine / ssh) never need it, and in remote modes
 *     the block is followed by the SDK's `Current working directory: <cwd>`
 *     line whose cwd is the CENTRAL SERVER's session directory (sandbox stub
 *     home / project config home) — showing it both distracts the model and
 *     leaks server paths. The execution environment is already described by
 *     the PI_WEB_ENV block (lib/extensions/environment-info.ts).
 *
 * Anchors are the SDK's upstream wording; if upstream renames them the strip
 * silently no-ops, which quick-prompt.test.mjs detects by building the real
 * base prompt from the installed SDK.
 */

export const PI_DOCS_BLOCK_START = "Pi documentation (read only when the user asks";
export const PI_DOCS_BLOCK_END = "(e.g., tui.md for TUI API details)";

const WORKING_DIRECTORY_LINE = /(^|\n)Current working directory:[^\n]*/gi;

/** Remove the whole SDK docs-index block (anchors included), tidying the
 *  blank-line seam. Returns the input unchanged when the anchors are absent. */
export function stripPiDocumentationBlock(prompt: string): string {
  const start = prompt.indexOf(PI_DOCS_BLOCK_START);
  if (start < 0) return prompt;
  const end = prompt.indexOf(PI_DOCS_BLOCK_END, start);
  if (end < 0) return prompt;
  const after = prompt.slice(end + PI_DOCS_BLOCK_END.length);
  let out = prompt.slice(0, start) + after.replace(/^[ \t]*\r?\n/, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

/** Remove the SDK's `Current working directory: <path>` line(s). Used for
 *  remote workspace modes where that path is a server-side config carrier the
 *  model must never touch; the real workspace is stated in PI_WEB_ENV. */
export function stripWorkingDirectoryLine(prompt: string): string {
  let out = prompt.replace(WORKING_DIRECTORY_LINE, "$1");
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
  return out.replace(/\s+$/, "");
}
