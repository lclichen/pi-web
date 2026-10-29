import { createWriteStream, readFileSync, rmSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getBundleUploadMaxMb } from "@/lib/server-settings";
import {
  deleteBundle,
  ensureBuiltinBundles,
  isProtectedBundleName,
  listBundles,
  isValidBundleName,
  newBundleTempPath,
  saveBundleFromFile,
} from "@/lib/config-bundles-store";
import { isApkgBytes, readApkgHeader } from "@/lib/apkg";
import { verifyZipStructure } from "@/lib/bundle-file-check";

export const dynamic = "force-dynamic";

/** Up to this size a plain zip is fully parsed (JSZip); larger packages get a
 *  structural check only — a full parse needs the whole archive in memory,
 *  which is what the streaming upload path exists to avoid. */
const FULL_ZIP_VERIFY_LIMIT = 32 * 1024 * 1024;

/** Stream any web ReadableStream into `path`, refusing to exceed `capBytes`. */
async function streamToFile(
  source: ReadableStream<Uint8Array> | null,
  path: string,
  capBytes: number,
): Promise<{ ok: true; bytes: number } | { ok: false }> {
  if (!source) {
    rmSync(path, { force: true });
    return { ok: false };
  }
  const out = createWriteStream(path);
  const reader = source.getReader();
  let received = 0;
  let tooLarge = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > capBytes) {
        tooLarge = true;
        break;
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
    if (tooLarge) await reader.cancel().catch(() => {});
  }
  if (tooLarge) {
    rmSync(path, { force: true });
    return { ok: false };
  }
  return { ok: true, bytes: received };
}

/** Shared validation + storage step for both upload wire formats. */
async function validateAndStore(name: string, description: string, tempPath: string): Promise<NextResponse> {
  try {
    const size = statSync(tempPath).size;
    if (size === 0) return NextResponse.json({ error: "上传内容为空" }, { status: 400 });
    const head = readFileSync(tempPath).subarray(0, 256 * 1024);
    if (isApkgBytes(head)) {
      // Encrypted package: validate the envelope header (zip integrity is
      // proven at apply time by the GCM tag; ciphertext is stored verbatim).
      try {
        readApkgHeader(head);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "加密配置包格式无效" }, { status: 400 });
      }
    } else if (size <= FULL_ZIP_VERIFY_LIMIT) {
      try {
        await JSZip.loadAsync(readFileSync(tempPath));
      } catch {
        return NextResponse.json({ error: "无法解析压缩包（需要 zip 或 .apkg 格式）" }, { status: 400 });
      }
    } else {
      const check = verifyZipStructure(tempPath);
      if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 400 });
    }
    saveBundleFromFile(name, description, tempPath);
    return NextResponse.json({ ok: true, name, size }, { status: 201 });
  } finally {
    // Finalize renames the temp file away on success; force-remove is a no-op.
    rmSync(tempPath, { force: true });
  }
}

// GET /api/bundles — list preset config bundles (any authenticated user; the
// wizard offers them at project creation). Seeds the built-in Agent Builder
// definition on first access.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  await ensureBuiltinBundles();
  return NextResponse.json({ bundles: listBundles() });
}

// POST /api/bundles — admin upload.
//   * Streaming (preferred, large files): raw octet-stream body with
//     ?name=&description=&filename= query params. Never buffered in memory.
//   * Multipart (legacy clients): file=<zip|apkg>, name, description.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可管理配置模板" }, { status: 403 });
  }

  const capBytes = getBundleUploadMaxMb() * 1024 * 1024;
  const capMb = Math.round(capBytes / 1024 / 1024);
  const url = new URL(req.url);
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  let name: string;
  let description: string;
  const tempPath = newBundleTempPath();

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      rmSync(tempPath, { force: true });
      return NextResponse.json({ error: "无法解析上传内容（需要 multipart 表单）" }, { status: 400 });
    }
    const file = form.get("file");
    const rawName = String(form.get("name") ?? "");
    description = String(form.get("description") ?? "");
    name = (rawName.trim() || (file instanceof File ? file.name.replace(/\.(zip|apkg)$/i, "") : "")).trim();
    if (!(file instanceof File) || file.size === 0) {
      rmSync(tempPath, { force: true });
      return NextResponse.json({ error: "缺少上传文件（字段名 file）" }, { status: 400 });
    }
    if (file.size > capBytes) {
      rmSync(tempPath, { force: true });
      return NextResponse.json({ error: `模板包过大（>${capMb}MB）` }, { status: 413 });
    }
    const streamed = await streamToFile(file.stream() as ReadableStream<Uint8Array>, tempPath, capBytes);
    if (!streamed.ok) {
      return NextResponse.json({ error: `模板包过大（>${capMb}MB）` }, { status: 413 });
    }
  } else {
    const rawName = url.searchParams.get("name") ?? "";
    description = url.searchParams.get("description") ?? "";
    const filename = url.searchParams.get("filename") ?? "";
    name = (rawName.trim() || filename.replace(/\.(zip|apkg)$/i, "")).trim();
    if (!req.body) {
      return NextResponse.json({ error: "上传内容为空" }, { status: 400 });
    }
    const streamed = await streamToFile(req.body, tempPath, capBytes);
    if (!streamed.ok) {
      return NextResponse.json({ error: `模板包过大（>${capMb}MB）` }, { status: 413 });
    }
    if (streamed.bytes === 0) {
      rmSync(tempPath, { force: true });
      return NextResponse.json({ error: "上传内容为空" }, { status: 400 });
    }
  }

  if (!isValidBundleName(name)) {
    rmSync(tempPath, { force: true });
    return NextResponse.json({ error: "模板名只能包含字母、数字、点、下划线、连字符（≤64 字符）" }, { status: 400 });
  }
  if (isProtectedBundleName(name)) {
    rmSync(tempPath, { force: true });
    return NextResponse.json({ error: "内置 Agent 定义不可覆盖（agent-builder）" }, { status: 403 });
  }
  return validateAndStore(name, description, tempPath);
}

// DELETE /api/bundles?name=… — admin remove a preset bundle.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可管理配置模板" }, { status: 403 });
  }
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!isValidBundleName(name)) {
    return NextResponse.json({ error: "非法模板名" }, { status: 400 });
  }
  if (isProtectedBundleName(name)) {
    return NextResponse.json({ error: "内置 Agent 定义不可删除（agent-builder）" }, { status: 403 });
  }
  if (!deleteBundle(name)) {
    return NextResponse.json({ error: "模板不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, name });
}
