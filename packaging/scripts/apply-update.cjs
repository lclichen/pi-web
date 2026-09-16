#!/usr/bin/env node
/**
 * apply-update.cjs — 自助更新的执行体（零依赖 Node 脚本）。
 *
 * 由 POST /api/app-update/apply 以 detached 进程拉起，与 WebUI 服务脱钩：
 *   下载产物 → sha256 校验 → 解包/暂存 → 停服 → 交换 → 回迁用户数据 → 重启 → 写终态。
 * 进度按 phase 写 <dataDir>/update-status.json（GET /api/app-update/status 读）。
 *
 * 用法：node apply-update.cjs '<json-config>'
 * config: { catalogSource, version, framework:{kind,fileName,relativePath,sha256,sizeBytes},
 *           pkgKind, appRoot, appImagePath, appDir, electronExec, dataDir }
 *
 * 交换语义（均可回滚，见各分支）：
 *   tarball/electron：appRoot → appRoot.bak-<ts>，staging 新根 → appRoot，随后把
 *     run/logs/config/data 四个用户数据目录从 .bak **mv 回**新根（同文件系统 O(1)，
 *     会话/容器 overlay/管理员密码全保住），重启 = start-all.sh（electron 形态同样
 *     只重启后端——存活的窗口会自动重连，避免撞单实例锁）。失败回滚 .bak。
 *   appimage：新文件经二次 sha 校验后原子替换 $APPIMAGE（旧件留 .bak，保留 1 份），
 *     停服用 $APPDIR（挂载点内的 stop-all.sh），重启新文件带 --web。
 */
"use strict";

const { createHash } = require("node:crypto");
const { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const config = JSON.parse(process.argv[2] || "{}");

/** self 模式：`AppImage --update` 外部更新入口——自己拉 catalog 并补全
 *  version/framework 字段，然后走标准 appimage 交换流程。 */
async function bootstrapSelf(raw) {
  if (!raw.catalogSource) throw new Error("self 模式缺少 catalogSource");
  const text = /^https?:\/\//i.test(raw.catalogSource)
    ? await (await fetch(raw.catalogSource, { redirect: "follow" })).text()
    : readFileSync(raw.catalogSource, "utf8");
  const catalog = JSON.parse(text);
  if (catalog.schema_version !== 1) throw new Error(`不支持的 catalog schema_version: ${catalog.schema_version}`);

  // 当前版本/通道：从 appDir 的 version.json 读（AppImage 的 payload 内）。
  let channel = "stable";
  let current = "";
  try {
    const v = JSON.parse(readFileSync(path.join(raw.appDir || ".", "version.json"), "utf8"));
    channel = v.channel || "stable";
    current = v.version || "";
  } catch { /* 无 version.json 用 default_version 通道 */ }
  const wanted = raw.version
    || (catalog.latest_versions && catalog.latest_versions[channel])
    || catalog.default_version;
  const entry = (catalog.versions || []).find((v) => v.version === wanted);
  if (!entry) throw new Error(`catalog 中不存在版本 ${wanted}`);
  const fw = entry.frameworks && (entry.frameworks[raw.pkgKind] || (raw.pkgKind === "electron" ? entry.frameworks.tarball : undefined));
  if (!fw) throw new Error(`版本 ${wanted} 没有 ${raw.pkgKind} 产物`);

  if (current && !raw.version) {
    // 简单比较：仅当目标不同才继续（允许外部强制指定版本做升级/降级/重装）。
    if (current === entry.version) {
      console.log(`apply-update: 已是 ${current}，无需更新（--update 指定版本可强制重装）`);
      process.exit(0);
    }
  }
  return {
    ...raw,
    catalogSource: raw.catalogSource,
    version: entry.version,
    framework: {
      kind: raw.pkgKind,
      fileName: fw.file_name,
      relativePath: fw.relative_path,
      sha256: fw.checksum_sha256,
      sizeBytes: fw.size_bytes || 0,
    },
  };
}

async function main() {
  if (!config.version || !config.framework || !config.pkgKind || !config.dataDir) {
    console.error("apply-update: 配置不完整");
    process.exit(2);
  }
  await runUpdate();
}

const STAGING_ROOT = path.join(config.dataDir, "update-staging");
const STAGING = path.join(STAGING_ROOT, String(Date.now()));
/**
 * tarball/electron 的解包目标。必须与 appRoot 同级且在其**外部**：dataDir 默认
 * 在包根内（appRoot/data/...），若解到 appRoot 里面，交换第一步（appRoot→.bak）
 * 会把暂存连同新根一起搬走，第二步 rename 就 ENOENT 了。
 */
const EXTRACT_DIR = config.pkgKind === "appimage"
  ? STAGING
  : `${config.appRoot}.update-staging-${Date.now()}`;
const STATUS_FILE = path.join(config.dataDir, "update-status.json");
const LOG_FILE = path.join(config.dataDir, "update.log");
/** 用户数据目录（tarball/electron 形态默认在包根内，交换后必须回迁）。 */
const DATA_DIRS = ["run", "logs", "config", "data"];

function log(line) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const stamp = new Date().toISOString();
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, prev + `[${stamp}] ${line}\n`);
  } catch { /* 日志尽力而为 */ }
  console.log(line);
}

function status(phase, extra = {}) {
  const payload = { phase, targetVersion: config.version, updatedAt: Date.now(), ...extra };
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const tmp = STATUS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, STATUS_FILE);
  } catch (e) {
    log(`写状态失败: ${e.message}`);
  }
  log(`[phase] ${phase} ${extra.message ? "— " + extra.message : ""}`);
}

/** catalog 源（http URL 或本地文件路径）+ relative_path → 实际下载源。 */
function resolveSource() {
  const { catalogSource } = config;
  const rel = config.framework.relativePath.replace(/^\/+/, "");
  if (/^https?:\/\//i.test(catalogSource)) {
    return new URL(rel, new URL("./", catalogSource)).toString();
  }
  return path.resolve(path.dirname(path.resolve(catalogSource)), rel);
}

function sha256File(file) {
  const hasher = createHash("sha256");
  hasher.update(readFileSync(file));
  return hasher.digest("hex");
}

async function download(source, dest) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || config.framework.sizeBytes || 0;
    const out = createWriteStream(dest);
    const hasher = createHash("sha256");
    let received = 0;
    let lastTick = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((resolve) => out.once("drain", resolve));
      hasher.update(value);
      received += value.length;
      const now = Date.now();
      if (total > 0 && now - lastTick > 500) {
        lastTick = now;
        status("downloading", { progress: Math.min(1, received / total), message: `${Math.round((received / total) * 100)}%` });
      }
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on("error", reject); });
    return hasher.digest("hex");
  }
  // 本地文件源（内网共享目录 / 同机 release 目录）
  status("downloading", { progress: 0.5, message: "复制本地文件…" });
  copyFileSync(source, dest);
  return sha256File(dest);
}

function extractTar(root, tarball) {
  mkdirSync(root, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", root], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`解压失败: ${(result.stderr || "").slice(0, 300)}`);
}

function stopServices(stopAllDir) {
  const stop = path.join(stopAllDir, "scripts", "stop-all.sh");
  if (existsSync(stop)) {
    spawnSync("bash", [stop], { timeout: 60_000, stdio: "ignore" });
    log(`已停止服务（${stop}）`);
  } else {
    log(`stop-all 不存在，跳过停服（${stop}）`);
  }
}

/** 目录交换后把用户数据从旧根 mv 回新根（同文件系统 O(1)）。 */
function migrateDataDirs(fromRoot, toRoot) {
  for (const dir of DATA_DIRS) {
    const from = path.join(fromRoot, dir);
    const to = path.join(toRoot, dir);
    if (!existsSync(from)) continue;
    try {
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
      log(`数据回迁: ${dir}`);
    } catch (e) {
      throw new Error(`回迁 ${dir} 失败: ${e.message}`);
    }
  }
}

/** 只保留最近 N 个 .bak-（与 appimage 新文件 .bak 共用策略）。 */
function pruneBackups(parent, prefix, keep = 1) {
  try {
    const baks = readdirSync(parent).filter((n) => n.startsWith(prefix)).sort();
    while (baks.length > keep) rmSync(path.join(parent, baks.shift()), { recursive: true, force: true });
  } catch { /* 清理旧备份尽力而为 */ }
}

async function runUpdate() {
  try {
    // 旧尝试的 staging 残留清掉（整包不小，别攒）——下载暂存与解包暂存两处。
    try {
      mkdirSync(STAGING_ROOT, { recursive: true });
      for (const name of readdirSync(STAGING_ROOT)) {
        if (path.join(STAGING_ROOT, name) !== STAGING) rmSync(path.join(STAGING_ROOT, name), { recursive: true, force: true });
      }
      if (config.appRoot && config.pkgKind !== "appimage") {
        const parent = path.dirname(config.appRoot);
        const prefix = path.basename(config.appRoot) + ".update-staging-";
        for (const name of readdirSync(parent)) {
          if (name.startsWith(prefix)) rmSync(path.join(parent, name), { recursive: true, force: true });
        }
      }
    } catch { /* 尽力而为 */ }
    mkdirSync(STAGING, { recursive: true });

    status("downloading", { progress: 0, message: "开始下载…" });
    const artifact = path.join(STAGING, config.framework.fileName);
    const sha = await download(resolveSource(), artifact);

    status("verifying", { message: "校验 sha256…" });
    if (sha !== config.framework.sha256.toLowerCase()) {
      throw new Error(`sha256 不匹配（期望 ${config.framework.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
    }

    if (config.pkgKind === "appimage") {
      if (!config.appImagePath) throw new Error("缺少 APPIMAGE 路径（非 AppImage 运行时？）");
      status("swapping", { message: "替换 AppImage 文件…" });
      const target = config.appImagePath;
      const incoming = `${target}.incoming`;
      const backup = `${target}.bak-${Date.now()}`;
      // 先落位新文件并二次校验，再动旧文件——任何失败都不影响正在运行的版本。
      copyFileSync(artifact, incoming);
      chmodSync(incoming, 0o755);
      if (sha256File(incoming) !== config.framework.sha256.toLowerCase()) {
        rmSync(incoming, { force: true });
        throw new Error("新 AppImage 复制后校验失败（磁盘问题？）");
      }
      renameSync(target, backup);
      try {
        renameSync(incoming, target);
      } catch (e) {
        renameSync(backup, target); // 落位失败立即恢复旧文件
        throw e;
      }
      pruneBackups(path.dirname(target), path.basename(target) + ".bak-");

      status("restarting", { message: "停止旧服务并启动新版本…" });
      stopServices(config.appDir || path.dirname(target));
      spawn(target, ["--web"], { detached: true, stdio: "ignore" }).unref();
    } else {
      if (!config.appRoot) throw new Error("缺少 AMEDAC_APP_ROOT");
      status("staging", { message: "解包新版本…" });
      const stagedRoot = path.join(EXTRACT_DIR, "root");
      extractTar(stagedRoot, artifact);
      // tar.gz 含一层顶层目录（amedac.ai-pi-linux-<arch>/）——取该层为新根。
      const entries = readdirSync(stagedRoot);
      let newRoot = stagedRoot;
      if (entries.length === 1 && statSync(path.join(stagedRoot, entries[0])).isDirectory()) {
        newRoot = path.join(stagedRoot, entries[0]);
      }
      if (!existsSync(path.join(newRoot, "scripts", "start-all.sh"))) {
        throw new Error("新包结构异常：缺少 scripts/start-all.sh");
      }

      status("swapping", { message: "停止服务并交换目录…" });
      stopServices(config.appRoot);
      const backup = `${config.appRoot}.bak-${Date.now()}`;
      renameSync(config.appRoot, backup);
      try {
        renameSync(newRoot, config.appRoot);
        migrateDataDirs(backup, config.appRoot); // 用户数据（config/data/run/logs）mv 回新根
      } catch (e) {
        // 交换或回迁失败：把数据搬回 .bak 后整体还原，并把旧版服务拉回来。
        try { migrateDataDirs(config.appRoot, backup); } catch { /* 双重失败，保留现场 */ }
        rmSync(config.appRoot, { recursive: true, force: true });
        renameSync(backup, config.appRoot);
        spawn("bash", [path.join(config.appRoot, "scripts", "start-all.sh")], { detached: true, stdio: "ignore" }).unref();
        throw e;
      }

      status("restarting", { message: "启动新版本…" });
      const start = path.join(config.appRoot, "scripts", "start-all.sh");
      const result = spawnSync("bash", [start], { timeout: 120_000, stdio: "ignore", detached: false });
      if (result.error || (result.status !== 0 && result.status !== null)) {
        // 启动失败：回滚旧根并尝试把旧版拉回来。
        log(`新版本启动失败（status=${result.status ?? result.error?.message}），回滚`);
        stopServices(config.appRoot);
        try {
          migrateDataDirs(config.appRoot, backup);
          rmSync(config.appRoot, { recursive: true, force: true });
          renameSync(backup, config.appRoot);
          spawn("bash", [path.join(config.appRoot, "scripts", "start-all.sh")], { detached: true, stdio: "ignore" }).unref();
        } catch (rollbackError) {
          log(`回滚亦失败: ${rollbackError.message}`);
        }
        throw new Error(`新版本启动失败（已回滚旧版；详见 ${LOG_FILE}）`);
      }
      pruneBackups(path.dirname(config.appRoot), path.basename(config.appRoot) + ".bak-");
    }

    rmSync(STAGING, { recursive: true, force: true }); // 下载暂存
    rmSync(EXTRACT_DIR, { recursive: true, force: true }); // 解包暂存（成功后新根已 mv 走，剩残壳）
    status("done", { message: `已更新到 ${config.version}；若页面未自动恢复，请稍后刷新。` });
    process.exit(0);
  } catch (e) {
    log(`失败: ${e.stack || e.message}`);
    status("failed", { error: e.message });
    process.exit(1);
  }
}


// ---- 入口（放文件尾：确保上方 const 声明先初始化，避免 TDZ）----
void (async () => {
  if (config.mode === "self") {
    try {
      const bootstrapped = await bootstrapSelf(config);
      Object.assign(config, bootstrapped);
      await main();
    } catch (e) {
      console.error(`apply-update: ${e.message}`);
      process.exit(1);
    }
  } else {
    await main();
  }
})();
