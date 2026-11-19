/**
 * .apkg decryption oracle — subprocess bridge to the internal `apkg-publisher`
 * binary (Go, format implementation lives there, not in this repo).
 *
 * Contract: the tool performs exactly one transformation —
 *   apkg-publisher open --in <pkg.apkg> --out -
 * ciphertext bytes in, plaintext zip bytes out on stdout. The recipient private
 * key is sealed into that binary at packaging time and decrypted only in memory;
 * pi-web has no private key and writes no plaintext zip to disk. The final
 * config files are still written by the normal import path (pi's extension/skill
 * loader reads them from disk).
 *
 * Header parsing, fingerprint (sha256 of the whole ciphertext), license
 * enforcement and locks stay in pi-web (lib/apkg.ts / project-config-bundle.ts),
 * so the tool never needs to evolve for policy changes.
 *
 * Tool resolution order:
 *   1. PI_WEB_APKG_TOOL env (absolute path)
 *   2. <cwd>/bin/apkg-publisher[.exe]   — packaged layout ships app/bin/
 *   3. <dataDir>/bin/apkg-publisher[.exe] — data-dir drop survives app updates
 *   4. bare name on PATH
 *
 * The public recipient metadata is read by lib/apkg.ts (PI_WEB_APKG_RECIPIENT,
 * <dataDir>/apkg-recipient.json, or the package config path).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";

const TOOL_BASENAME = "apkg-publisher";
const OPEN_TIMEOUT_MS = 90_000;
const MAX_PLAINTEXT_BYTES = 512 * 1024 * 1024;

function exeCandidates(base: string): string[] {
  return process.platform === "win32" ? [`${base}.exe`, base] : [base, `${base}.exe`];
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
  return existsSyncOnPath(TOOL_BASENAME) ? TOOL_BASENAME : null;
}

function existsSyncOnPath(name: string): boolean {
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
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
 * Decrypt .apkg bytes to the plain zip via the external tool. The plaintext
 * zip is captured from stdout and never written to a temp file.
 */
export async function openApkgViaTool(data: Buffer): Promise<Buffer> {
  const tool = resolveApkgTool();
  if (!tool) {
    throw new Error(
      "此部署未配备 .apkg 解密组件（缺少 apkg-publisher 二进制；可通过 PI_WEB_APKG_TOOL 指定路径，或放到 <数据目录>/bin/）",
    );
  }

  const work = mkdtempSync(join(tmpdir(), "apkg-open-"));
  const inFile = join(work, "pkg.apkg");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("PI_WEB_APKG_")) delete childEnv[key];
  }
  try {
    writeFileSync(inFile, data);
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let failure: Error | null = null;
      const child = spawn(
        tool,
        ["open", "--in", inFile, "--out", "-"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // Do not inherit deployment secrets (e.g. the old PI_WEB_APKG_KEYS).
          // The child only needs its own binary/PATH; the identity path is a file.
          env: childEnv,
        },
      );
      const timer = setTimeout(() => {
        failure = new Error("配置包解密超时");
        child.kill();
      }, OPEN_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (failure) return;
        total += chunk.length;
        if (total > MAX_PLAINTEXT_BYTES) {
          failure = new Error("配置包解密后的内容过大");
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
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
        if (failure) return reject(failure);
        if (code !== 0) {
          const detail = stderr.replace(/^错误:\s*/m, "").trim();
          return reject(new Error(detail || `解密组件退出码 ${code}`));
        }
        return resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
