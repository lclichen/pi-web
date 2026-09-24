#!/usr/bin/env node
/**
 * pack-apkg — publisher-side CLI that wraps a plain config-bundle zip into
 * an encrypted .apkg envelope (commercial-protection.md §一).
 *
 * Usage (from the pi-web checkout, Node ≥ 22):
 *   node --experimental-strip-types scripts/pack-apkg.ts \
 *     --in course-lab-config.zip \
 *     --name course-lab --title "课程实验配置" --version 1.2.0 \
 *     --desc "第一学期实验包" --channel stable \
 *     --expires 2027-09-01 --max-imports 50
 *
 * Key handling:
 *   --keys <file>   key store (default <dataDir>/apkg-keys.json, i.e.
 *                   PI_WEB_DATA_DIR or ./data). Missing store / keyId ⇒ a
 *                   fresh KEK generation is provisioned and persisted.
 *                   Deploy the SAME file to every pi-web server that must
 *                   open this package (dataDir/apkg-keys.json).
 *   --key-id <id>   use a specific generation (≤16 bytes).
 *
 * Output: the .apkg plus a printed fingerprint (identity for import
 * counters and .bundle-lock entries).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { packApkg, type ApkgLicense } from "../lib/apkg-format.ts";

interface Args {
  in?: string;
  out?: string;
  keys?: string;
  keyId?: string;
  name?: string;
  title?: string;
  desc?: string;
  version?: string;
  channel?: string;
  expires?: string;
  maxImports?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少参数值: ${a}`);
      return v;
    };
    switch (a) {
      case "--in": args.in = next(); break;
      case "--out": args.out = next(); break;
      case "--keys": args.keys = next(); break;
      case "--key-id": args.keyId = next(); break;
      case "--name": args.name = next(); break;
      case "--title": args.title = next(); break;
      case "--desc": args.desc = next(); break;
      case "--version": args.version = next(); break;
      case "--channel": args.channel = next(); break;
      case "--expires": args.expires = next(); break;
      case "--max-imports": args.maxImports = next(); break;
      default: throw new Error(`未知参数: ${a}`);
    }
  }
  return args;
}

function resolveKeysStore(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const dataDir = process.env.PI_WEB_DATA_DIR ?? resolve("data");
  return resolve(dataDir, "apkg-keys.json");
}

function loadOrCreateKek(storePath: string, keyId?: string): { keyId: string; kek: Buffer } {
  let store: Record<string, string> = {};
  if (existsSync(storePath)) {
    store = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>;
  }
  if (keyId) {
    if (keyId.length > 16) throw new Error(`--key-id 过长（≤16 字节）: ${keyId}`);
    const b64 = store[keyId];
    if (b64) {
      const kek = Buffer.from(b64, "base64");
      if (kek.length !== 32) throw new Error(`密钥 ${keyId} 长度异常，请重新生成`);
      return { keyId, kek };
    }
  }
  // Provision a fresh generation (explicit id, or dated default).
  const id = keyId ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(2).toString("hex")}`;
  const kek = randomBytes(32);
  store[id] = kek.toString("base64");
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  console.log(`已生成新密钥代 ${id} 并写入 ${storePath}`);
  console.log(`⚠ 请将此文件部署为每台需要导入该包的 pi-web 服务器的 <数据目录>/apkg-keys.json`);
  return { keyId: id, kek };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) throw new Error("缺少 --in <zip 路径>（先用界面导出的明文 zip）");
  if (!existsSync(args.in)) throw new Error(`输入文件不存在: ${args.in}`);

  const name = args.name ?? basename(args.in).replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-");
  const { keyId, kek } = loadOrCreateKek(resolveKeysStore(args.keys), args.keyId);

  const license: ApkgLicense = {};
  if (args.expires) {
    // Accept YYYY-MM-DD (end of day) or a full ISO timestamp.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(args.expires)
      ? `${args.expires}T23:59:59Z`
      : args.expires;
    if (!Number.isFinite(Date.parse(iso))) throw new Error(`--expires 无法解析: ${args.expires}`);
    license.expiresAt = new Date(iso).toISOString();
  }
  if (args.maxImports !== undefined) {
    const n = Number(args.maxImports);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--max-imports 需为非负整数: ${args.maxImports}`);
    license.maxImports = n;
  }

  const zipBytes = readFileSync(args.in);
  const { bytes, fingerprint } = await packApkg(zipBytes, {
    package: {
      name,
      title: args.title ?? name,
      description: args.desc ?? "",
      version: args.version ?? "1.0.0",
      channel: args.channel ?? "stable",
    },
    license,
    kek,
    keyId,
  });

  const out = args.out ?? args.in.replace(/\.zip$/i, "") + ".apkg";
  writeFileSync(out, bytes);
  console.log(`已生成加密配置包: ${out}`);
  console.log(`  keyId:       ${keyId}`);
  console.log(`  name/version: ${name} v${args.version ?? "1.0.0"} (${args.channel ?? "stable"})`);
  if (license.expiresAt) console.log(`  过期时间:    ${license.expiresAt}`);
  if (license.maxImports !== undefined) console.log(`  导入上限:    ${license.maxImports} 次/服务器`);
  console.log(`  指纹:        ${fingerprint}`);
  console.log(`  大小:        ${(bytes.length / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error(`错误: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
