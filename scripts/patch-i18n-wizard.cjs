// 向导 + 菜单词条（zh 自映射 + en 映射）
const fs = require("fs");
const EN = {
  "+ 新建项目": "+ New project",
  "远程连接": "Remote connection",
  "打开服务器目录": "Open server directory",
  "选择方式": "Choose method",
  "填写配置": "Configuration",
  "连接中": "Connecting",
  "选择目录": "Choose directory",
  "选择连接方式": "Choose a connection method",
  "连接沙盒": "Sandbox",
  "平台容器 · 镜像可选": "Platform container · image selectable",
  "连接本地": "This computer",
  "你自己的电脑（一个 Agent 连接可跑多个项目）": "Your own machine (one agent connection serves multiple projects)",
  "SSH 连接": "SSH",
  "远程主机 · 即将推出": "Remote host · coming soon",
  "即将推出": "Coming soon",
  "下一步": "Next",
  "上一步": "Back",
  "完成": "Finish",
  "配置沙盒项目的运行环境，创建后项目会话将在容器 /workspace 内执行。": "Configure the sandbox project's environment; sessions will run inside the container /workspace.",
  "正在创建容器并准备项目环境…": "Creating the container and preparing the project environment…",
  "本机模式按用户配对：一个 Agent 连接可以承载多个项目，各项目使用不同的工作目录。": "Local-machine mode is paired per user: one agent connection serves multiple projects, each with its own working directory.",
  "下一步会校验本机 Agent 的配对状态；尚未配对时请先在侧栏「本机机器」面板完成连接。": "The next step verifies the local agent pairing; if not paired yet, connect via the Local machine panel in the sidebar first.",
  "本机尚未配对：请先在侧栏「本机机器」面板完成配对，再回到本步骤。": "Local machine not paired yet: pair it via the Local machine panel in the sidebar, then return to this step.",
  "无法获取本机连接状态": "Unable to fetch local-machine connection status",
  "本机 Agent 已连接": "Local agent connected",
  "正在校验本机 Agent 连接…": "Verifying the local agent connection…",
  "填写连接配置": "Connection settings",
  "本机工作目录（可选）": "Local working directory (optional)",
  "如：my-local-lab": "e.g. my-local-lab",
  "沙盒项目的目录固定为容器 /workspace——项目会话、终端与文件面板都在其中执行。": "A sandbox project's directory is fixed to the container /workspace — sessions, terminal and the file panel all operate there.",
};
function patch(file, isZh) {
  let src = fs.readFileSync(file, "utf8");
  let n = 0;
  for (const [k, v] of Object.entries(EN)) {
    if (src.includes(JSON.stringify(k) + ":")) continue;
    const entry = "    " + JSON.stringify(k) + ": " + JSON.stringify(isZh ? k : v) + ",";
    src = src.replace('    "common.plugins"', entry + "\n    \"common.plugins\"");
    n++;
  }
  fs.writeFileSync(file, src);
  return n;
}
console.log("en added:", patch("lib/i18n/messages/en.ts", false), "| zh added:", patch("lib/i18n/messages/zh-CN.ts", true));
