/**
 * VM 工具共享层 — 连接 + SSH 执行 + SFTP + 环境规范。
 *
 * 凭据仍走 scripts/vm-credentials.cjs（gitignored）或 VM_HOST/VM_USER/VM_PASSWORD
 * 环境变量（与旧 vm-connection.cjs 同一套，二者保持兼容）。
 */
const path = require("node:path");
const { Client } = require("ssh2");

const ROOT = path.join(__dirname, "..", "..");
const REMOTE_APP = "/home/llmx/amedac/pi-web";
const REMOTE_LOG = "/home/llmx/amedac/piweb.log";
const PORT = 30141;

function loadConnection() {
  const { VM_HOST, VM_USER, VM_PASSWORD } = process.env;
  if (VM_HOST && VM_USER && VM_PASSWORD) {
    return { host: VM_HOST, username: VM_USER, password: VM_PASSWORD };
  }
  try {
    return require(path.join(ROOT, "scripts", "vm-credentials.cjs"));
  } catch {
    console.error(
      "缺少 VM 凭据。任选其一：\n" +
        "  1) 导出环境变量 VM_HOST / VM_USER / VM_PASSWORD；\n" +
        "  2) cp scripts/vm-credentials.example.cjs scripts/vm-credentials.cjs 并填入真实值（已被 .gitignore 排除）。",
    );
    process.exit(1);
  }
}

/** 打开一条 SSH 连接，回调拿到包装好的 exec/sftp。 */
function withConnection(fn) {
  const c = new Client();
  c.on("error", (e) => {
    console.error("SSH FAIL:", e.message);
    process.exit(1);
  });
  c.on("ready", () => {
    fn({
      client: c,
      /** 执行 shell 片段（bash -s，非交互；需 node 时自行 export PATH）。 */
      exec: (script, { timeoutSec = 120, quiet = false } = {}) =>
        new Promise((resolve) => {
          c.exec(`timeout ${timeoutSec} bash -s`, (err, stream) => {
            if (err) return resolve({ code: 1, out: String(err) });
            let out = "";
            stream.on("data", (d) => (out += d)).on("stderr", (d) => (out += d));
            stream.on("close", (code) => {
              if (!quiet) process.stdout.write(out);
              resolve({ code: code ?? 0, out });
            });
            stream.write(script);
            stream.end();
          });
        }),
      /** 上传本地文件（相对 pi-web 仓根）到 VM 同路径。 */
      put: (localRel) =>
        new Promise((resolve, reject) => {
          c.sftp((err, sftp) => {
            if (err) return reject(err);
            const local = path.join(ROOT, ...localRel.split("/"));
            const remote = `${REMOTE_APP}/${localRel.split("/").join("/")}`;
            const mkdirs = (dir, cb) => {
              const parts = dir.split("/").filter(Boolean);
              let cur = "";
              const step = () => {
                if (!parts.length) return cb();
                cur += "/" + parts.shift();
                sftp.mkdir(cur, () => step());
              };
              step();
            };
            mkdirs(path.posix.dirname(remote), () => {
              sftp.fastPut(local, remote, (e2) => (e2 ? reject(new Error(`${localRel}: ${e2.message}`)) : resolve(remote)));
            });
          });
        }),
      end: () => c.end(),
    });
  }).connect({ ...loadConnection(), readyTimeout: 15000 });
}

/** VM 上重启 pi-web 的规范脚本片段：优先继承当前进程的 PI_WEB_* 环境。 */
function restartScript() {
  return `
export PATH=/home/llmx/tools/node/bin:$PATH
PID=$(ss -tlnp | grep :${PORT} | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
# 继承现网进程的 PI_WEB_* / AMEDAC_* 环境（自愈：重启不会丢配置）
if [ -n "$PID" ]; then
  for kv in $(tr "\\0" "\\n" < /proc/$PID/environ | grep -E "^(PI_WEB|AMEDAC)" ); do export "$kv"; done
  kill $PID; sleep 2
fi
cd ${REMOTE_APP}
setsid nohup node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT} > ${REMOTE_LOG} 2>&1 < /dev/null &
sleep 5
ss -tlnp | grep :${PORT} | head -1
curl -s -o /dev/null -w "home: %{http_code}\\n" -m 10 http://127.0.0.1:${PORT}/
`;
}

module.exports = { withConnection, restartScript, loadConnection, REMOTE_APP, REMOTE_LOG, PORT, ROOT };
