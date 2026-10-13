import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { packApkg, type ApkgLicense } from "@/lib/apkg-format";
import { apkgKeysStorePath, getOrCreateApkgKek } from "@/lib/apkg-keys";

export const dynamic = "force-dynamic";

// POST /api/apkg/pack — 发布方打包（/packager 页面后端）。
//   { zipBase64, name?, title?, desc?, version?, channel?, expiresAt?, maxImports?,
//     keyId? }  → { apkgBase64, fileName, fingerprint, keyId, isNewKey }
// 与 scripts/pack-apkg.ts 同一实现（lib/apkg-format + lib/apkg-keys）。
// keyId 语义与 CLI 一致：给了且存在 → 用它；给了不存在 → 新建同名代；
// 没给 → 用仓中代（当前无仓则新建）。zipBase64 上限 48MB（明文 zip 通常 KB 级）。

const MAX_ZIP_B64_CHARS = 64 * 1024 * 1024;

function sanitizeName(raw: string): string {
  return raw.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 64) || "config-package";
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员（发布方）可用" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    zipBase64?: unknown; name?: unknown; title?: unknown; desc?: unknown;
    version?: unknown; channel?: unknown; expiresAt?: unknown; maxImports?: unknown; keyId?: unknown;
    zipFileName?: unknown;
  } | null;
  if (!body || typeof body.zipBase64 !== "string" || body.zipBase64.length === 0) {
    return NextResponse.json({ error: "缺少 zipBase64（先上传明文配置包 zip）" }, { status: 400 });
  }
  if (body.zipBase64.length > MAX_ZIP_B64_CHARS) {
    return NextResponse.json({ error: "zip 过大（>48MB）——加密配置包面向 KB 级配置内容" }, { status: 413 });
  }
  const zipBytes = Buffer.from(body.zipBase64, "base64");
  if (zipBytes.length < 4 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
    return NextResponse.json({ error: "不是有效的 zip 文件（缺 PK 头）" }, { status: 400 });
  }

  const name = typeof body.name === "string" && body.name.trim()
    ? sanitizeName(body.name.trim())
    : sanitizeName(typeof body.zipFileName === "string" ? body.zipFileName : "config-package");

  const license: ApkgLicense = {};
  if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt.trim())
      ? `${body.expiresAt.trim()}T23:59:59Z`
      : body.expiresAt.trim();
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return NextResponse.json({ error: `expiresAt 无法解析: ${body.expiresAt}` }, { status: 400 });
    license.expiresAt = new Date(t).toISOString();
  }
  if (body.maxImports !== undefined && body.maxImports !== null && body.maxImports !== "") {
    const n = Number(body.maxImports);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: `maxImports 需为非负整数: ${body.maxImports}` }, { status: 400 });
    }
    license.maxImports = n;
  }

  try {
    const storePath = apkgKeysStorePath();
    const keyId = typeof body.keyId === "string" && body.keyId.trim() ? body.keyId.trim() : undefined;
    const { keyId: resolvedKeyId, kek, isNew } = getOrCreateApkgKek(storePath, keyId);
    const { bytes, fingerprint } = await packApkg(zipBytes, {
      package: {
        name,
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : name,
        description: typeof body.desc === "string" ? body.desc.trim() : "",
        version: typeof body.version === "string" && body.version.trim() ? body.version.trim() : "1.0.0",
        channel: typeof body.channel === "string" && body.channel.trim() ? body.channel.trim() : "stable",
      },
      license,
      kek,
      keyId: resolvedKeyId,
    });
    return NextResponse.json({
      apkgBase64: bytes.toString("base64"),
      fileName: `${name}.apkg`,
      byteSize: bytes.length,
      fingerprint,
      keyId: resolvedKeyId,
      isNewKey: isNew,
      storePath,
      license: Object.keys(license).length > 0 ? license : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
