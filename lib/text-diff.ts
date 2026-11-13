/**
 * Minimal unified diff for the workspace-config sync preview.
 *
 * Config files are small; a line-LCS is enough. Inputs above the LCS budget
 * fall back to a "common prefix/suffix + changed block" diff, and the output is
 * truncated so a pathological file cannot bloat the preview response.
 */

export interface TextDiffOptions {
  context?: number;
  maxLcsLines?: number;
  maxOutputChars?: number;
}

/** NUL or invalid UTF-8 ⇒ binary; the caller shows size/hash instead of a diff. */
export function isProbablyText(content: Buffer): boolean {
  if (content.includes(0)) return false;
  return Buffer.from(content.toString("utf8"), "utf8").equals(content);
}

type Edit = { type: "same" | "del" | "add"; line: string };

function lcsEdits(oldLines: string[], newLines: string[], maxLines: number): Edit[] | null {
  if (oldLines.length > maxLines || newLines.length > maxLines) return null;
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      edits.push({ type: "same", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      edits.push({ type: "del", line: oldLines[i] });
      i += 1;
    } else {
      edits.push({ type: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) edits.push({ type: "del", line: oldLines[i++] });
  while (j < m) edits.push({ type: "add", line: newLines[j++] });
  return edits;
}

/** Prefix/suffix trim for files above the LCS budget. */
function blockEdits(oldLines: string[], newLines: string[]): Edit[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < prefix; i += 1) edits.push({ type: "same", line: oldLines[i] });
  for (let i = prefix; i < oldLines.length - suffix; i += 1) edits.push({ type: "del", line: oldLines[i] });
  for (let i = prefix; i < newLines.length - suffix; i += 1) edits.push({ type: "add", line: newLines[i] });
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) edits.push({ type: "same", line: oldLines[i] });
  return edits;
}

function hunkify(edits: Edit[], context: number): string[] {
  const changed = edits.map((e, index) => (e.type === "same" ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(edits.length - 1, changed[0] + context);
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(edits.length - 1, index + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(edits.length - 1, index + context);
    }
  }
  ranges.push([start, end]);

  const out: string[] = [];
  // Line counters over the whole edit list.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const edit of edits) {
    oldAt.push(oldNo + 1);
    newAt.push(newNo + 1);
    if (edit.type !== "add") oldNo += 1;
    if (edit.type !== "del") newNo += 1;
  }
  for (const [from, to] of ranges) {
    let oldCount = 0;
    let newCount = 0;
    for (let i = from; i <= to; i += 1) {
      if (edits[i].type !== "add") oldCount += 1;
      if (edits[i].type !== "del") newCount += 1;
    }
    out.push(`@@ -${oldAt[from]},${oldCount} +${newAt[from]},${newCount} @@`);
    for (let i = from; i <= to; i += 1) {
      const edit = edits[i];
      out.push(`${edit.type === "same" ? " " : edit.type === "del" ? "-" : "+"}${edit.line}`);
    }
  }
  return out;
}

/** Unified diff text, with a `(diff truncated)` marker when over the cap. */
export function unifiedTextDiff(
  oldText: string,
  newText: string,
  label: string,
  options: TextDiffOptions = {},
): string {
  const context = options.context ?? 3;
  const maxLines = options.maxLcsLines ?? 800;
  const maxChars = options.maxOutputChars ?? 64 * 1024;
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const edits = lcsEdits(oldLines, newLines, maxLines) ?? blockEdits(oldLines, newLines);
  const header = [`--- a/${label}`, `+++ b/${label}`];
  const body = hunkify(edits, context);
  if (body.length === 0) return "";
  const text = [...header, ...body].join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (diff truncated)`;
}
