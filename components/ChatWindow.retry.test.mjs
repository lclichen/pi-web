import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

/**
 * Manual retry of a failed turn: only when the LAST message is an assistant
 * with stopReason "error"; branch back to the user message that produced it
 * (so the failed attempt stays in the tree) and resend text + base64 images.
 */
test("retry is offered only for the last failed turn", () => {
  assert.match(source, /const retryableErrorIndex = useMemo\(\(\) => \{/);
  assert.match(source, /last\.role !== "assistant" \|\| last\.stopReason !== "error"\) return -1/);
  assert.match(
    source,
    /onRetry=\{\s*idx === retryableErrorIndex && !sessionBusy && !retryInfo\s*\? handleRetryLastTurn\s*:\s*undefined\s*\}/,
  );
});

test("retry branches to the user entry and resends the same content", () => {
  const handler = source.slice(
    source.indexOf("const handleRetryLastTurn = useCallback"),
    source.indexOf("const [quotedSelection"),
  );
  assert.match(handler, /if \(sessionBusy \|\| retryInfo \|\| retryableErrorIndex < 0\) return;/);
  // Finds the user message preceding the failed assistant turn.
  assert.match(handler, /messages\[i\]\?\.role === "user"/);
  // Navigates to that message's branch entry before resending.
  assert.match(handler, /const navigated = await handleNavigate\(entryId\)/);
  assert.match(handler, /await handleSend\(text, images\.length > 0 \? images : undefined\)/);
  // Base64 images survive the retry with a data-URL preview.
  assert.match(handler, /block\.source\.type === "base64"/);
  assert.match(handler, /previewUrl: `data:\$\{mimeType\};base64,\$\{block\.source\.data\}`/);
});
