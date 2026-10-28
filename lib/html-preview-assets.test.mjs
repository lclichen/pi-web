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

test("FileViewer wiring: iframe srcDoc + markdown preview img route through the rewrite / remote", async () => {
  const source = await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /srcDoc=\{rewriteHtmlPreviewAssets\(content, \{\s*dir: getFileDirectory\(filePath\),\s*cwd,\s*toUrl: \(p\) => getFileApiUrl\(p, "read", sourceSessionId, undefined, remote\),/,
  );
  assert.match(source, /getFileApiUrl\(imagePath, "read", sourceSessionId, undefined, remote\)/);
});
