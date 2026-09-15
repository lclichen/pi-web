/**
 * amedac.ai Electron 主进程 —— 把既有自包含服务包（package-linux 产物）包成
 * 桌面应用：拉起 sandbox-platform + pi-web（scripts/start-all.sh），健康后开
 * BrowserWindow 加载 WebUI；退出时停服。
 *
 * 目录约定（package-electron.sh 组装）：
 *   <electron-dist>/resources/app/main.js   ← 本文件
 *   <electron-dist>/resources/app/bundle/   ← 自包含服务包（pkg-kind=electron）
 * 可写区与其他形态共用 AMEDAC_HOME（默认 ~/.local/share/amedac）——config/run/
 * logs/data 全部外置，bundle 目录保持"纯代码"，自更新交换它不会动用户数据。
 */
"use strict";

const { app, BrowserWindow, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// 官方 prebuilt zip 解包后 chrome-sandbox 的 setuid 位通常丢失，非 root 启动会
// 直接失败；两条启动路径（用户首启 / 更新器重启）统一在 main 里兜底。
app.commandLine.appendSwitch("no-sandbox");

const APP_DIR = path.dirname(__filename);
const BUNDLE = path.join(APP_DIR, "bundle");
const RUNTIME_HOME = process.env.AMEDAC_HOME
  ?? path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || "~", ".local", "share"), "amedac");
const RUN_DIR = path.join(RUNTIME_HOME, "run");

// 可写区外置（与 AppImage 的 AppRun 同一套变量，start-all/stop-all 都吃）。
process.env.AMEDAC_CONFIG_DIR = path.join(RUNTIME_HOME, "config");
process.env.AMEDAC_RUN_DIR = RUN_DIR;
process.env.AMEDAC_LOG_DIR = path.join(RUNTIME_HOME, "logs");
process.env.DATA_DIR = path.join(RUNTIME_HOME, "data");

function log(line) {
  try {
    fs.mkdirSync(process.env.AMEDAC_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(process.env.AMEDAC_LOG_DIR, "electron.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 尽力而为 */ }
  console.log(line);
}

let bundleRoot = BUNDLE;
if (!fs.existsSync(path.join(bundleRoot, "scripts", "start-all.sh"))) {
  // 开发模式回落：AMEDAC_ELECTRON_BUNDLE 指向构建产物目录
  const devBundle = process.env.AMEDAC_ELECTRON_BUNDLE;
  if (devBundle && fs.existsSync(path.join(devBundle, "scripts", "start-all.sh"))) {
    bundleRoot = devBundle;
  }
}

let mainWindow = null;
let servicesChild = null;

function startServices() {
  const start = path.join(bundleRoot, "scripts", "start-all.sh");
  if (!fs.existsSync(start)) {
    log(`找不到启动脚本：${start}（先运行 scripts/package-linux.sh）`);
    app.quit();
    return;
  }
  for (const dir of [process.env.AMEDAC_CONFIG_DIR, RUN_DIR, process.env.AMEDAC_LOG_DIR, process.env.DATA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  servicesChild = spawn("bash", [start], {
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      // 更新器需要：应用根（可交换目录 = bundle）、部署形态、electron 入口。
      AMEDAC_APP_ROOT: bundleRoot,
      AMEDAC_PKG_KIND: "electron",
      AMEDAC_ELECTRON_EXEC: process.execPath,
      AMEDAC_ELECTRON_RESOURCES: path.dirname(APP_DIR),
    },
  });
  servicesChild.on("exit", (code) => log(`start-all.sh 退出（code=${code}）`));
  log(`服务已拉起（bundle=${bundleRoot}）`);
}

function stopServices() {
  const stop = path.join(bundleRoot, "scripts", "stop-all.sh");
  if (fs.existsSync(stop)) {
    try {
      spawnSync("bash", [stop], { timeout: 30_000, stdio: "ignore" });
      log("服务已停止");
    } catch (e) {
      log(`停服异常: ${e.message}`);
    }
  }
}

function readWebPort() {
  try {
    const env = fs.readFileSync(path.join(RUN_DIR, "ports.env"), "utf8");
    const m = /^WEB_PORT=(\d+)$/m.exec(env);
    if (m) return Number(m[1]);
  } catch { /* 尚未生成 */ }
  return Number(process.env.WEB_PORT || 30141);
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ? res.statusCode < 500 : false);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitForWeb(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await probe(`http://127.0.0.1:${readWebPort()}/`);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: "amedac.ai",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 用 contextBridge；禁 Chromium 沙箱以兼容部分发行版
    },
  });
  // 站外链接交给系统浏览器，不在应用窗口里导航走。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(`http://127.0.0.1:${readWebPort()}`)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    startServices();
    const win = createWindow();
    win.loadURL("data:text/html,<body style='background:#0a0a0a;color:#888;font-family:system-ui;display:grid;place-items:center;height:100vh'><div>amedac.ai 启动中…</div></body>");
    const ready = await waitForWeb(90_000);
    if (!mainWindow) return; // 等待期间被关掉
    if (!ready) {
      win.loadURL("data:text/html,<body style='background:#0a0a0a;color:#f87171;font-family:system-ui;display:grid;place-items:center;height:100vh'><div>服务启动超时——查看 amedac 日志目录后重试</div></body>");
      return;
    }
    win.loadURL(`http://127.0.0.1:${readWebPort()}/`);
    // 服务重启窗口期（应用自更新等）：连接被拒/中断时周期性重试加载。
    mainWindow.webContents.on("did-fail-load", (event, code) => {
      if (code === -3 || code === -102 || code === -101) {
        const retry = setInterval(async () => {
          if (!mainWindow) { clearInterval(retry); return; }
          if (await waitForWeb(5000)) {
            clearInterval(retry);
            if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${readWebPort()}/`);
          }
        }, 3000);
      }
    });
  });

  app.on("window-all-closed", () => {
    stopServices();
    app.quit();
  });
}
