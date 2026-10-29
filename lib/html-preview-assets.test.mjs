import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * lib/html-preview-assets.ts: the sandboxed <iframe srcDoc> HTML preview has
 * no base URL, so local file references must be rewritten before rendering
 * (embedded images break otherwise — markdown works because its preview
 * rewrites each <img> in component overrides). toUrl is injected so these
 * tests pin resolver semantics without the file-API encoding details.
 */

async function api() {
  return jiti.import("./html-preview-assets.ts");
}

const OPTS = { dir: "/work/site", cwd: "/work", toUrl: (p) => `URL<${p}>` };

test("relative asset references resolve against the html directory", async () => {
  const { rewriteHtmlPreviewAssets } = await api();
  const out = rewriteHtmlPreviewAssets(
    `<img src="pic.png"><script src="js/app.js"></script><link rel="stylesheet" href="style.css">`,
    OPTS,
  );
  assert.equal(
    out,
    `<img src="URL</work/site/pic.png>"><script src="URL</work/site/js/app.js>"></script><link rel="stylesheet" href="URL</work/site/style.css>">`,
  );
});

test("absolute paths pass verbatim; ../ collapses and stays inside the cwd fence", async () => {
  const { rewriteHtmlPreviewAssets } = await api();
  const out = rewriteHtmlPreviewAssets(`<img src="/work/site/img/logo.png"><img src="../assets/x.png">`, OPTS);
  assert.match(out, /src="URL<\/work\/site\/img\/logo\.png>"/);
  // /work/site/../assets/x.png → /work/assets/x.png
  assert.match(out, /src="URL<\/work\/assets\/x\.png>"/);
});

test("external, data, fragment and non-asset references pass through untouched", async () => {
  const { rewriteHtmlPreviewAssets } = await api();
  const html = `<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,xxx">
<a href="page.html">link</a><a href="#sec">anchor</a><div data-src="pic.png">x</div>`;
  const out = rewriteHtmlPreviewAssets(html, OPTS);
  assert.equal(out, html);
});

test("srcset candidates rewrite individually; & in produced URLs is escaped", async () => {
  const { rewriteHtmlPreviewAssets } = await api();
  const out = rewriteHtmlPreviewAssets(`<img srcset="a.png 1x, https://cdn.x/b.png 2x" src="fallback.png">`, OPTS);
  assert.equal(
    out,
    `<img srcset="URL</work/site/a.png> 1x, https://cdn.x/b.png 2x" src="URL</work/site/fallback.png>">`,
  );
  const amp = rewriteHtmlPreviewAssets(`<img src="pic.png">`, { ...OPTS, toUrl: (p) => `/f?p=${p}&copy=2` });
  assert.equal(amp, `<img src="/f?p=/work/site/pic.png&amp;copy=2">`);
});

test("collectHtmlPreviewAssetPaths dedupes and resolves the same refs as the rewrite", async () => {
  const { collectHtmlPreviewAssetPaths } = await api();
  const paths = collectHtmlPreviewAssetPaths(
    `<img src="pic.png"><img src="./pic.png"><img src="/work/site/abs.png"><img src="https://cdn.x/a.png">`,
    { dir: "/work/site", cwd: "/work" },
  );
  assert.deepEqual(paths.sort(), ["/work/site/abs.png", "/work/site/pic.png"]);
});

test("inlineHtmlPreviewAssets embeds fetched assets as data: URLs (cookie-free sandbox)", async () => {
  const { inlineHtmlPreviewAssets } = await api();
  const fetched = [];
  const out = await inlineHtmlPreviewAssets(`<img src="pic.png"><img src="big.png"><img src="missing.png">`, {
    dir: "/work/site",
    cwd: "/work",
    toUrl: (p) => `URL<${p}>`,
    fetchAsset: async (abs) => {
      fetched.push(abs);
      if (abs.endsWith("pic.png")) return { contentType: "image/png", bytes: Uint8Array.from([1, 2, 3]).buffer };
      if (abs.endsWith("big.png")) return { contentType: "image/png", bytes: new ArrayBuffer(64) };
      return null;
    },
    maxAssetBytes: 32,
  });
  assert.match(out, /src="data:image\/png;base64,AQID"/);
  // Oversize and failed assets keep the URL fallback instead of a broken data:.
  assert.match(out, /src="URL<\/work\/site\/big\.png>"/);
  assert.match(out, /src="URL<\/work\/site\/missing\.png>"/);
  assert.deepEqual(fetched.sort(), ["/work/site/big.png", "/work/site/missing.png", "/work/site/pic.png"]);
});

test("FileViewer wiring: iframe srcDoc (inlined doc → rewrite fallback) + markdown img route through remote", async () => {
  const source = await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /htmlPreviewDoc \?\?\s*rewriteHtmlPreviewAssets\(content, \{/);
  assert.match(source, /inlineHtmlPreviewAssets\(viewerContent, \{/);
  assert.match(source, /getFileApiUrl\(imagePath, "read", sourceSessionId, undefined, remote\)/);
});
