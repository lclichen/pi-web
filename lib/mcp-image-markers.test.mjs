import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { rewriteMcpImageMarkers, extractMcpImageIds, sessionImageUrl } = await jiti.import("./mcp-image-markers.ts");

test("rewrites markers to the session image endpoint", () => {
  const text = `前置\n\n[[image:img_ab12cd34ef56|首页截图]]\n\n后置`;
  assert.equal(
    rewriteMcpImageMarkers(text, "sess_1"),
    `前置\n\n![首页截图](/api/sessions/sess_1/images/img_ab12cd34ef56)\n\n后置`,
  );
});

test("leaves code fences and inline code untouched", () => {
  const fenced = "```md\n[[image:img_ab12cd34ef56|示例]]\n```";
  assert.equal(rewriteMcpImageMarkers(fenced, "sess_1"), fenced);

  const inline = "use `[[image:img_ab12cd34ef56]]` literally";
  assert.equal(rewriteMcpImageMarkers(inline, "sess_1"), inline);
});

test("supports multiple markers, escaped alt text, and no session", () => {
  const text = "[[image:img_aaaaaaaaaaaaaaaa|图\\一]] and [[image:img_bbbbbbbbbbbbbbbb]]";
  assert.match(
    rewriteMcpImageMarkers(text, "sess/one"),
    /!\[图\\\\一\]\(\/api\/sessions\/sess%2Fone\/images\/img_aaaaaaaaaaaaaaaa\)/,
  );
  assert.equal(rewriteMcpImageMarkers(text, undefined), text);
});

test("extracts ids in order for fallback galleries", () => {
  assert.deepEqual(extractMcpImageIds("[[image:img_aaaaaaaaaaaaaaaa|x]] [[image:img_bbbbbbbbbbbbbbbb]]"), [
    "img_aaaaaaaaaaaaaaaa",
    "img_bbbbbbbbbbbbbbbb",
  ]);
  assert.equal(sessionImageUrl("s", "img_aaaaaaaaaaaaaaaa"), "/api/sessions/s/images/img_aaaaaaaaaaaaaaaa");
});
