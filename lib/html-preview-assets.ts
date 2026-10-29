import { resolveLocalFileHref } from "./file-links";

/**
 * Rewrite local file references (img/source/link/script… src/href/poster/
 * srcset) for the sandboxed <iframe srcDoc> HTML preview: srcDoc has no base
 * URL, so relative references resolve against about:srcdoc and embedded
 * assets silently break. Resolution semantics mirror the markdown preview's
 * per-<img> override (lib/file-links resolveLocalFileHref): relative refs
 * resolve under the html directory and must stay inside the cwd fence;
 * absolute paths pass verbatim; external/data URIs and fragments are left
 * untouched. The caller supplies toUrl to turn an absolute local path into a
 * displayable file-API URL (local /api/files vs remote /api/remotefs).
 */

const ASSET_TAG_RE = /^(img|image|source|video|audio|link|script|embed|track|iframe)$/i;

export interface HtmlAssetRewriteOptions {
  /** Directory of the html file — base for relative references. */
  dir: string;
  /** Fence root for relative references (session cwd); defaults to dir. */
  cwd?: string | null;
  /** Absolute local path → displayable URL. */
  toUrl: (absPath: string) => string;
}

function rewriteSrcsetUrls(value: string, resolve: (v: string) => string | null): string | null {
  let changed = false;
  const out = value
    .split(",")
    .map((candidate) => {
      const m = candidate.match(/^(\s*)(\S+)([\s\S]*?)$/);
      if (!m || !m[2]) return candidate;
      const rewritten = resolve(m[2]);
      if (!rewritten) return candidate;
      changed = true;
      return `${m[1]}${rewritten}${m[3]}`;
    })
    .join(",");
  return changed ? out : null;
}

export function rewriteHtmlPreviewAssets(html: string, options: HtmlAssetRewriteOptions): string {
  const resolve = (value: string): string | null => {
    const abs = resolveLocalFileHref(value.trim(), options.dir, options.cwd ?? options.dir);
    if (!abs) return null;
    return options.toUrl(abs);
  };
  return rewriteWithResolver(html, resolve);
}

/**
 * Collect every local asset path referenced by the html (same tag/attribute
 * rules as the rewrite). Callers use this to fetch + inline the assets as
 * data: URLs — the sandboxed preview iframe has an OPAQUE origin, so cookie-
 * authenticated /api/files requests from it are cross-site and lose the
 * SameSite=Lax cookie (403). Inlining happens in the app page instead, where
 * the fetch is first-party.
 */
export function collectHtmlPreviewAssetPaths(html: string, options: { dir: string; cwd?: string | null }): string[] {
  const seen = new Set<string>();
  rewriteWithResolver(html, (value) => {
    const abs = resolveLocalFileHref(value.trim(), options.dir, options.cwd ?? options.dir);
    if (abs) seen.add(abs);
    return null; // no rewrite — collection only
  });
  return [...seen];
}

function rewriteWithResolver(html: string, resolve: (value: string) => string | null): string {
  return html.replace(/<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"<>])*)>/g, (match, tag: string, attrs: string) => {
    if (!ASSET_TAG_RE.test(tag)) return match;
    const next = attrs.replace(
      /(\s)(src|href|poster|srcset)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (attrMatch, lead: string, name: string, raw: string) => {
        const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : "";
        const value = quote ? raw.slice(1, -1) : raw;
        const rewritten = name.toLowerCase() === "srcset" ? rewriteSrcsetUrls(value, resolve) : resolve(value);
        if (!rewritten) return attrMatch;
        // Escape & so query strings can't be eaten as HTML entities
        // (e.g. ?src=s1&copy=2 would render as ©=2).
        const escaped = rewritten.replace(/&/g, "&amp;");
        return quote ? `${lead}${name}=${quote}${escaped}${quote}` : `${lead}${name}="${escaped}"`;
      },
    );
    return next === attrs ? match : `<${tag}${next}>`;
  });
}

/**
 * Inline local assets as data: URLs for the sandboxed HTML preview.
 *
 * Why: the preview runs in <iframe sandbox="allow-scripts"> with an opaque
 * origin. Its /api/files requests are therefore cross-site, the session
 * cookie is SameSite=Lax, and the browser refuses to send it — images and
 * stylesheets 403 while the same URL loads fine from the markdown preview
 * (first-party page). Fetching here (app origin) and embedding data: URLs
 * keeps the sandbox strict instead of weakening it with allow-same-origin.
 */
export interface InlineHtmlAssetOptions extends HtmlAssetRewriteOptions {
  fetchAsset: (absPath: string) => Promise<{ contentType: string; bytes: ArrayBuffer } | null>;
  /** Per-asset cap; larger assets keep their URL (and may still 403). */
  maxAssetBytes?: number;
  /** Total budget across the document; further assets keep their URL. */
  maxTotalBytes?: number;
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function inlineHtmlPreviewAssets(html: string, options: InlineHtmlAssetOptions): Promise<string> {
  const maxAsset = options.maxAssetBytes ?? 8 * 1024 * 1024;
  const maxTotal = options.maxTotalBytes ?? 24 * 1024 * 1024;
  const paths = collectHtmlPreviewAssetPaths(html, options);
  const inlined = new Map<string, string>();
  let total = 0;
  for (const abs of paths) {
    try {
      const asset = await options.fetchAsset(abs);
      if (!asset || asset.bytes.byteLength === 0) continue;
      if (asset.bytes.byteLength > maxAsset || total + asset.bytes.byteLength > maxTotal) continue;
      total += asset.bytes.byteLength;
      const type = asset.contentType || "application/octet-stream";
      inlined.set(abs, `data:${type};base64,${toBase64(asset.bytes)}`);
    } catch {
      // Leave the URL fallback in place for this asset.
    }
  }
  return rewriteHtmlPreviewAssets(html, {
    dir: options.dir,
    cwd: options.cwd,
    toUrl: (abs) => inlined.get(abs) ?? options.toUrl(abs),
  });
}
