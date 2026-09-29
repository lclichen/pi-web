#!/usr/bin/env node
/**
 * VM 统一入口 —— 部署/测试/运维一个命令。
 *
 *   node scripts/vm/vm.cjs status                 端口/进程/环境/磁盘一览
 *   node scripts/vm/vm.cjs probe  '<shell>'       一次性 shell（通用逃生门）
 *   node scripts/vm/vm.cjs build                  npm run build（失败打日志尾）
 *   node scripts/vm/vm.cjs restart                重启 pi-web（继承现网 PI_WEB_* 环境）
 *   node scripts/vm/vm.cjs deploy [--branch dev]  git 部署主流程：fetch+reset → build → restart → 冒烟
 *                                                 ⚠ 只部署【已推送】的提交（与既有约定一致）
 *   node scripts/vm/vm.cjs hot-sync <file...>     未提交文件热同步 + build + restart（⚠ 明确逃生门）
 *   node scripts/vm/vm.cjs logs [N]               tail piweb.log
 *   node scripts/vm/vm.cjs npm-install            恢复 devDeps（打包脚本跑过之后必须）
 *   node scripts/vm/vm.cjs test <name>            跑测试族：auth | todo | pkg-layout | firstrun
 *
 * 设计约定：
 *  - 代码同步以 git 为主（deploy）；hot-sync 仅用于未提交代码的临时验证，
 *    用后要么提交走 deploy 转正，要么 git checkout 恢复，避免 VM 树漂移。
 *  - 磁盘常年 85-95%：deploy 前可用 probe 'df -h /' 检查；清理配方见 README。
 */
const { withConnection, restartScript, REMOTE_APP, REMOTE_LOG } = require("./lib.cjs");

const [cmd, ...args] = process.argv.slice(2);
const needConn = (fn) => withConnection(async (vm) => { await fn(vm); vm.end(); });

const HELP = __filename
  ? `用法见文件头注释：node scripts/vm/vm.cjs <status|probe|build|restart|deploy|hot-sync|logs|npm-install|test>`
  : "";

async function main() {
  switch (cmd) {
    case "status":
      return needConn((vm) => vm.exec(`
echo "== 端口"; ss -tlnp | grep -E ":3000|:30141|:30142" | head -5
PID=$(ss -tlnp | grep :30141 | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
echo "== pi-web pid=$PID"; [ -n "$PID" ] && tr "\\0" "\\n" < /proc/$PID/environ | grep -E "^PI_WEB" | sed "s/=/=<set>/"
echo "== 磁盘"; df -h / | tail -1
echo "== 数据目录"; du -sh ~/amedac/piweb-data 2>/dev/null | head -1
`, { timeoutSec: 30 }));

    case "probe": {
      const script = args[0];
      if (!script) { console.error("probe 需要 '<shell 片段>'"); process.exit(1); }
      return needConn((vm) => vm.exec(script, { timeoutSec: 300 }));
    }

    case "build":
      return needConn((vm) => vm.exec(`
export PATH=/home/llmx/tools/node/bin:$PATH
cd ${REMOTE_APP}
if npm run build > /tmp/vm-build.log 2>&1; then echo BUILD-OK; else echo BUILD-FAIL; tail -30 /tmp/vm-build.log; exit 1; fi
`, { timeoutSec: 300 }));

    case "restart":
      return needConn((vm) => vm.exec(restartScript(), { timeoutSec: 60 }));

    case "deploy": {
      const branch = args.includes("--branch") ? args[args.indexOf("--branch") + 1] : "dev";
      return needConn((vm) => vm.exec(`
export PATH=/home/llmx/tools/node/bin:$PATH
set -e
cd ${REMOTE_APP}
echo "== git 同步（只部署已推送提交）"
git fetch origin ${branch} 2>&1 | tail -2 || true
git reset --hard origin/${branch}
git log --oneline -1
if [ ! -d node_modules/typescript ]; then echo "== typescript 缺失，先 npm install"; npm install --no-audit --no-fund 2>&1 | tail -3; fi
if npm run build > /tmp/vm-build.log 2>&1; then echo BUILD-OK; else echo BUILD-FAIL; tail -30 /tmp/vm-build.log; exit 1; fi
${restartScript()}
echo "== 冒烟"
# /api/webauth/config 是 pre-session 路由（proxy 白名单），无需登录即可探活
curl -s -o /dev/null -w "webauth-config: %{http_code}\\n" -m 10 http://127.0.0.1:30141/api/webauth/config
`, { timeoutSec: 600 }));
    }

    case "hot-sync": {
      const files = args.filter((a) => !a.startsWith("--"));
      if (!files.length) { console.error("hot-sync 需要 <file...>（相对仓根路径）"); process.exit(1); }
      return needConn(async (vm) => {
        console.log("⚠ 热同步未提交文件 —— 验证后请提交并走 deploy 转正，或 git checkout 恢复 VM 树");
        for (const f of files) {
          await vm.put(f);
          console.log("synced", f);
        }
        await vm.exec(`
export PATH=/home/llmx/tools/node/bin:$PATH
cd ${REMOTE_APP}
if npm run build > /tmp/vm-build.log 2>&1; then echo BUILD-OK; else echo BUILD-FAIL; tail -30 /tmp/vm-build.log; exit 1; fi
${restartScript()}
`, { timeoutSec: 600 });
      });
    }

    case "logs": {
      const n = Number(args[0]) || 50;
      return needConn((vm) => vm.exec(`tail -${n} ${REMOTE_LOG}`, { timeoutSec: 30 }));
    }

    case "npm-install":
      return needConn((vm) => vm.exec(`
export PATH=/home/llmx/tools/node/bin:$PATH
cd ${REMOTE_APP}
npm install --no-audit --no-fund 2>&1 | tail -5
ls node_modules/typescript >/dev/null && echo "typescript: OK"
`, { timeoutSec: 900 }));

    case "test": {
      const map = {
        auth: "scripts/vm-auth-test3.cjs",
        todo: "scripts/vm-todo-test.cjs",
        "pkg-layout": "scripts/vm-pkg-layout-test.cjs",
        firstrun: "scripts/vm-firstrun-verify.cjs",
      };
      const target = map[args[0]];
      if (!target) { console.error(`未知测试 ${args[0]}；可用：${Object.keys(map).join(" | ")}`); process.exit(1); }
      const { spawnSync } = require("node:child_process");
      const r = spawnSync(process.execPath, [require("node:path").join(__dirname, "..", "..", target)], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }

    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
