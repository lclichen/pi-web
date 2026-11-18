/**
 * Client-side resolver for MCP image markers.
 *
 * MCP tool results carry images as separate content blocks; the model can only
 * repeat text, so the adapter leaves a short marker at the image position:
 *
 *   [[image:img_ab12cd34ef56|alt text]]
 *
 * The final assistant message keeps that marker even after the model rewrites
 * the surrounding prose. This module rewrites markers to a same-origin
 * `/api/sessions/<id>/images/<imageId>` URL that MarkdownBody already knows how
 * to render (and embed-token-augment). Code fences and inline code are left
 * untouched: a marker inside an example is text, not an image.
 */

export const MCP_IMAGE_MARKER_SOURCE = String.raw`\[\[image:(img_[A-Za-z0-9]+)(?:\|([^\]\n]*))?\]\]`;

const MARKER_RE = new RegExp(MCP_IMAGE_MARKER_SOURCE, "g");

/** Same-origin URL for one stored session image. */
export function sessionImageUrl(sessionId: string, imageId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`;
}

function rewriteOutsideInlineCode(line: string, sessionId: string): string {
  // Split on backticks: even segments are ordinary text, odd segments are
  // inline-code spans. Markers inside a span stay literal.
  return line
    .split("`")
    .map((segment, index) =>
      index % 2 === 0
        ? segment.replace(MARKER_RE, (_full, imageId: string, alt?: string) => {
            const label = (alt ?? "").replace(/[\\\]]/g, "\\$&");
            return `![${label}](${sessionImageUrl(sessionId, imageId)})`;
          })
        : segment,
    )
    .join("`");
}

/**
 * Rewrite `[[image:...]]` markers in assistant markdown. Fenced code blocks are
 * skipped as a whole; inline code is skipped per line.
 */
export function rewriteMcpImageMarkers(text: string, sessionId: string | null | undefined): string {
  if (!sessionId || !text.includes("[[image:")) return text;

  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = match?.[1];
    if (fence) {
      if (marker && marker.charAt(0) === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker.charAt(0), length: marker.length };
      continue;
    }
    lines[index] = rewriteOutsideInlineCode(line, sessionId);
  }
  return lines.join("\n");
}

/** Image ids referenced by an assistant/tool text; used by the fallback gallery. */
export function extractMcpImageIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKER_RE)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

/** Remove markers from a tool-result preview (images render separately there). */
export function stripMcpImageMarkers(text: string): string {
  if (!text.includes("[[image:")) return text;
  return text
    .replace(MARKER_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
