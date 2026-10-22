/**
 * .apkg decryption oracle — subprocess bridge to the internal `apkg-publisher`
 * binary (Go, format implementation lives there, not in this repo).
 *
 * Contract: the tool performs exactly one transformation —
 *   apkg-publisher open --in <pkg.apkg> --keys <keys.json> --out <plain.zip>
 * ciphertext bytes in, plaintext zip bytes out. Header parsing, fingerprint
 * (sha256 of the whole ciphertext file), license enforcement and locks all
 * stay in pi-web (lib/apkg.ts / project-config-bundle.ts), so the tool never
 * needs to evolve for policy changes.
 *
 * Tool resolution order:
 *   1. PI_WEB_APKG_TOOL env (absolute path)
 *   2. <cwd>/bin/apkg-publisher[.exe]   — packaged layout ships app/bin/
 *   3. <dataDir>/bin/apkg-publisher[.exe] — data-dir drop survives app updates
 *   4. bare name on PATH
 *
 * Deployments without the tool can still use everything except .apkg imports;
 * those fail with an explicit "component missing" error (plain .zip bundles
 * are unaffected).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";

const TOOL_BASENAME = "apkg-publisher";
const OPEN_TIMEOUT_MS = 90_000;

function exeCandidates(base: string): string[] {
  // Both spellings are probed on every platform: a Windows checkout with the
  // linux binary present (or vice versa) resolves the right one anyway.
  return process.platform === "win32"
    ? [`${base}.exe`, base]
    : [base, `${base}.exe`];
}

/**
 * Absolute path of the decryption tool, or null when this deployment has none.
 * An explicitly configured PI_WEB_APKG_TOOL is authoritative: a broken path
 * surfaces as a spawn error at open time instead of silently falling back.
 */
export function resolveApkgTool(): string | null {
  if (process.env.PI_WEB_APKG_TOOL) return process.env.PI_WEB_APKG_TOOL;
  const search: string[] = [];
  search.push(...exeCandidates(join(process.cwd(), "bin", TOOL_BASENAME)));
  try {
    search.push(...exeCandidates(join(dataDir(), "bin", TOOL_BASENAME)));
  } catch {
    // dataDir may be unavailable pre-config — PATH fallback still applies
  }
  for (const candidate of search) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable path — keep looking
    }
  }
  // PATH fallback: the bare name is probed with PATHEXT resolution on
  // Windows (apkg-publisher → apkg-publisher.exe/.cmd/…) and literally on
  // POSIX; spawn() resolves PATH itself, so the bare name is returned.
  return existsSyncOnPath(TOOL_BASENAME) ? TOOL_BASENAME : null;
}

function existsSyncOnPath(name: string): boolean {
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, name + ext))) return true;
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return false;
}

/**
 * Decrypt .apkg bytes to the plain zip via the external tool.
 * `keys` maps keyId → KEK (merged server key store, or a test override) and
 * is materialized into a 0600 temp file for the child process.
 */
export async function openApkgViaTool(data: Buffer, keys: Record<string, Buffer>): Promise<Buffer> {
  const tool = resolveApkgTool();
  if (!tool) {
    throw new Error(
      "此部署未配备 .apkg 解密组件（缺少 apkg-publisher 二进制；可通过 PI_WEB_APKG_TOOL 指定路径，或放到 <数据目录>/bin/）",
    );
  }

  const work = mkdtempSync(join(tmpdir(), "apkg-open-"));
  const inFile = join(work, "pkg.apkg");
  const keysFile = join(work, "keys.json");
  const outFile = join(work, "plain.zip");
  try {
    writeFileSync(inFile, data);
    const keyJson: Record<string, string> = {};
    for (const [keyId, kek] of Object.entries(keys)) keyJson[keyId] = kek.toString("base64");
    writeFileSync(keysFile, JSON.stringify(keyJson), { mode: 0o600 });
    try { chmodSync(keysFile, 0o600); } catch { /* fs without chmod */ }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(tool, ["open", "--in", inFile, "--keys", keysFile, "--out", outFile], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("配置包解密超时"));
      }, OPEN_TIMEOUT_MS);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new Error(`解密组件不可用（${tool}）：请检查 PI_WEB_APKG_TOOL 路径或重新部署组件`));
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        // Go CLI errors print as "错误: <message>" — surface the message body.
        const detail = stderr.replace(/^错误:\s*/m, "").trim();
        reject(new Error(detail || `解密组件退出码 ${code}`));
      });
    });

    return readFileSync(outFile);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
