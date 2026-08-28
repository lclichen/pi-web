// 一次性补丁：向 en.ts / zh-CN.ts 追加 chrome/status/np/pst 命名空间词条。
// zh-CN 侧写入「key=key」自映射（中文即 key 模式），保证生产环境无缺失警告。
const fs = require("fs");

/** key(中文原文或命名键) -> 英文 */
const EN = {
  // ---- AppShell 顶栏 ----
  "沙箱容器": "Sandbox container",
  "本机": "Local machine",
  "此文件有未保存的修改，关闭将丢弃。确定关闭吗？": "This file has unsaved changes. Close and discard?",
  "新会话": "New session",
  "会话：{name}": "Session: {name}",
  "远程会话": "Remote session",
  "我的工作区：云端文件留存（建项目时可初始化 /workspace）": "My Workspace: cloud-persisted files (can seed /workspace when creating a project)",
  "我的工作区": "My Workspace",
  "沙箱容器管理（新建/启停/删除/快照/绑定项目）": "Sandbox containers (create/start-stop/delete/snapshots/bind project)",
  "沙盒平台管理台（镜像/用户/配额/LLM）：{url}": "Sandbox platform console (images/users/quotas/LLM): {url}",
  "平台管理": "Platform Admin",
  "教学面板：已开启（点击对全员关闭）": "Teaching panel: ON (click to disable for everyone)",
  "教学面板：已关闭（点击对全员开启）": "Teaching panel: OFF (click to enable for everyone)",
  "教学": "Teaching",
  "登出（{name}）": "Log out ({name})",
  "登出": "Log out",
  "拖动调整高度（双击复位）": "Drag to resize (double-click to reset)",
  "沙箱": "Sandbox",
  "{kind}会话创建后（发送第一条消息）即可使用远程终端": "Send the first message to enable the remote terminal ({kind} session)",
  "文件": "Files",
  "子智能体目录": "Subagent directory",
  "智能体": "Agents",
  "计划": "Plan",
  "选择或创建一个会话后可查看子智能体调用记录": "Select or create a session to view subagent calls",

  // ---- ChatStatusWidget ----
  "会话状态：计划 / 智能体 / 终端": "Session status: Plan / Agents / Terminal",
  "状态": "Status",
  "{n} 运行中": "{n} running",
  "底部终端（工作区 shell）": "Bottom terminal (workspace shell)",
  "终端": "Terminal",
  "已打开": "Open",
  "等待 TODO 工具接入": "Awaiting TODO tool integration",
  "进程": "Processes",
  "待接入": "Pending",

  // ---- NewProjectDialog ----
  "新建沙箱项目": "New sandbox project",
  "新建本机项目": "New local-machine project",
  "项目名称": "Project name",
  "如：lab1-hello": "e.g. lab1-hello",
  "运行环境": "Runtime environment",
  "（加载中…）": " (loading…)",
  "（平台默认）": "(platform default)",
  "（每人限 {n} 个实例）": "({n} per user)",
  "新建容器": "New container",
  "使用已有容器": "Use existing container",
  "（暂无可复用的容器）": "(no reusable containers)",
  "选择容器…": "Choose a container…",
  "运行中": "Running",
  "已停止": "Stopped",
  "从我的工作区初始化 /workspace": "Seed /workspace from my cloud workspace",
  "（复用已有容器时不做初始化，保留容器内现有环境）": "(no init when reusing; keep the container's current environment)",
  "把云端文件拷入新容器（仅创建时，容器内改动不回写）": "Copy cloud files into the new container (one-time; changes don't sync back)",
  "（暂无工作区，创建后可在「我的工作区」上传）": "(no workspace yet — upload via My Workspace)",
  "复用已有容器：会话在该容器 /workspace 内执行，环境与文件保持原样。": "Reuse an existing container: sessions run in its /workspace with the environment intact.",
  "创建时自动准备容器（约数秒），会话在容器 /workspace 内执行。": "A container is provisioned automatically (a few seconds); sessions run in its /workspace.",
  "项目会话通过本机 Agent 在你配对的工作区内执行。": "Project sessions run on your paired machine via the local agent.",
  "取消": "Cancel",
  "创建中…": "Creating…",
  "创建": "Create",

  // ---- ProjectSessionTree ----
  "删除项目「{name}」及其配置目录？（会话记录保留）": "Delete project \"{name}\" and its config directory? (Sessions are kept)",
  "创建失败：HTTP {code}": "Creation failed: HTTP {code}",
  "恢复存档？容器 /workspace 将回到存档时间点，之后的改动会丢失。": "Restore this save? /workspace reverts to the snapshot point; later changes are lost.",
  "操作失败：HTTP {code}": "Operation failed: HTTP {code}",
  "已保存存档（保留最近 2 个）。": "Save created (the last 2 are kept).",
  "项目没有绑定容器": "Project has no bound container",
  "工作区不可用": "Cloud workspace unavailable",
  "导出失败：HTTP {code}": "Export failed: HTTP {code}",
  "已导出到我的工作区：{file}（仅文件；完整环境请用存档）": "Exported to My Workspace: {file} (files only; use saves for the full environment)",
  "+ 沙箱项目": "+ Sandbox project",
  "+ 本机项目": "+ Local-machine project",
  "打开服务器目录": "Open server directory",
  "搜索会话…": "Search sessions…",
  "没有匹配的会话": "No matching sessions",
  "项目：{name}": "Project: {name}",
  "未分组": "Ungrouped",
  "无容器": "No container",
  "沙盒": "Sandbox",
  "本地": "Local",
  "项目会话在容器 /workspace 内执行": "Project sessions run inside the container /workspace",
  "项目菜单": "Project menu",
  "显示全部 {n} 个会话": "Show all {n} sessions",
  "暂无会话，点 ＋ 新建": "No sessions yet — click ＋ to create",
  "还没有项目——点上方按钮创建第一个。": "No projects yet — use a button above to create one.",
  "重命名": "Rename",
  "项目新名称：": "New project name:",
  "复制为新项目": "Duplicate as new project",
  "设置（模型凭证等）": "Settings (model credentials…)",
  "导入项目配置…": "Import project config…",
  "存档 {n}/2（游戏存档制，保留最近 2 个）": "Saves {n}/2 (most recent 2 kept)",
  "保存存档（快照当前容器）": "Save state (snapshot current container)",
  "导出到我的工作区（tar.gz）": "Export to My Workspace (tar.gz)",
  "跟随平台默认容器": "Follow platform default container",
  "管理沙箱容器（新建/启停/删除）…": "Manage sandbox containers (create/start-stop/delete)…",
  "删除项目": "Delete project",
  "删除会话": "Delete session",
  "置顶": "Pin",
  "取消置顶": "Unpin",
};

function patchDict(file, isZh) {
  let src = fs.readFileSync(file, "utf8");
  const anchor = src.includes('"common.plugins"') ? '"common.plugins"' : null;
  const lines = [];
  for (const [k, en] of Object.entries(EN)) {
    if (src.includes(`"${k}":`)) continue; // 已存在跳过
    const value = isZh ? k : en;
    const escapedKey = k.replace(/"/g, '\\"');
    lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(value)},`);
  }
  // 插在 common.plugins 行之后
  const idx = src.indexOf(anchor);
  const lineEnd = src.indexOf("\n", idx);
  src = src.slice(0, lineEnd + 1) + lines.join("\n") + "\n" + src.slice(lineEnd + 1);
  fs.writeFileSync(file, src);
  return lines.length;
}

const nEn = patchDict("lib/i18n/messages/en.ts", false);
const nZh = patchDict("lib/i18n/messages/zh-CN.ts", true);
console.log(`added ${nEn} en entries, ${nZh} zh entries`);
