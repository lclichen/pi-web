/**
 * Built-in "Agent Builder" config bundle ( Agents 管理 · Agent 定义 ).
 *
 * 参考 Z Agent Builder（docs.bigmodel.cn/cn/managed-agents/builder-skill）
 * 的对话式构建工作流改造：套用到项目后，项目内的 Agent 即成为
 * "Agent Builder"——在 .pi/ 下开发新的 Agent 定义（系统提示、扩展
 * nodejs 代码、技能、子代理、模型、MCP），按打包规范自检，最后指导
 * 用户经"导出配置包"交付并上传 Agents 管理。
 *
 * 目录纪律：一切 Agent 相关配置只落 .pi/（labs/ 已废弃——历史包仍可
 * 导入，但新包不再携带）；这使路径白名单只需覆盖 .pi/** 即可防止
 * Agent 自行操作运行文件。
 *
 * 1.1.0：随包附带三份开发技能（pi-extension-dev / skill-creator /
 * subagent-creator，源码在 pi-config/agent/skills/），构建时嵌入
 * .pi/skills/<name>/，让 Builder 会话在写扩展/技能/子代理前能先读规范。
 */
import JSZip from "jszip";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const BUILTIN_AGENT_BUILDER_NAME = "agent-builder";
export const BUILTIN_AGENT_BUILDER_VERSION = "1.1.0";

/** Developer skills shipped inside the builder bundle (source of truth:
 *  pi-config/agent/skills/, copied verbatim into .pi/skills/ of the zip). */
export const BUILTIN_AGENT_BUILDER_SKILLS = ["pi-extension-dev", "skill-creator", "subagent-creator"] as const;

const AGENTS_MD = `# Agent Builder

你是 Agent Builder：在当前项目里开发"Agent 定义"（可分发、可版本化的配置包）。

## 工作流（参考 Z Agent Builder，按需裁剪）

1. **整理配置方案**（写进对话，先让用户确认再动手）：
   - 目标 Agent 的定位与系统提示词（写入 .pi/agents/<name>.md 或项目 AGENTS.md）
   - 模型（.pi/models.json）、MCP 服务器（.pi/mcp.json）
   - 技能（.pi/skills/<name>/SKILL.md）、子代理（.pi/subagents.json / .pi/agents/）
   - 需要内置 nodejs 代码的扩展（.pi/extensions/<name>/，package.json + index.js）
   - 环境依赖（如 node>=20、ripgrep、python>=3.11）
2. **搭建 .pi/ 结构并编写内容**：只创建/修改 .pi/ 下的文件与项目根的 AGENTS.md。
3. **自检**：结构与 manifest 规范逐项核对（见 agent-packaging 技能）；扩展代码做语法级检查。
4. **交付**：告知用户"项目菜单 → 导出配置包"，由管理员上传到 设置 → Agents 管理。

## 内置技能库（.pi/skills/，随本包分发）

写任何一类产物前，先读对应技能的 SKILL.md（它按需引用 references/ 下的细目）：

- **pi-extension-dev**——pi 扩展开发：工具/命令/事件/UI/打包规范。写
  .pi/extensions/ 下的 nodejs 扩展前必读；先跑通最小示例，再按需翻
  references/events.md、tools.md、commands-providers.md、context-ui.md。
- **skill-creator**——新建或改写技能：SKILL.md 结构、description 触发
  词、渐进披露（references/）、脚本效率检查（scripts/skill-efficiency-check.py）。
- **subagent-creator**——设计子代理：角色边界、工具权限最小化、多代理
  协作与交接（examples/ 有可参考定义）。

## 目录纪律（硬约束）

- **只写 .pi/** 与项目根 AGENTS.md；绝不触碰其他任何路径。
- .pi/ 下的运行态文件（sessions/ tmp/ bin/ cache/ plans/ 与 .git/）一律不读写。
- 不使用 labs/ 目录（已废弃；历史包兼容导入，新定义一律 .pi/）。
- 凭据文件（auth.json、ssh.json、sandbox-platform.json）绝不创建或改动。

## manifest.json 规范（打包导出时由导出器生成；开发时按此声明依赖）

\`\`\`json
{
  "format": { "version": 2, "exportedAt": "<ISO 8601>" },
  "package": {
    "name": "<kebab-case 标识>",
    "title": "<展示名>",
    "description": "<一句话描述>",
    "version": "<semver>",
    "channel": "stable",
    "dependencies": ["node>=20", "ripgrep"]
  }
}
\`\`\`

- dependencies 为字符串数组：环境依赖（运行时、CLI 工具），会展示在
  Agents 管理的"依赖"区；更详细的说明写 readme.md。
- 修改 Agent 定义后递增 package.version（语义化：能力变更 minor，修复 patch）。
`;

const PACKAGING_SKILL_MD = `---
name: agent-packaging
description: Agent 定义（配置包）的打包规范与自检清单——开发新 Agent 定义时必读。
---

# Agent 定义打包规范

## 目录结构（全部在 .pi/ 下；labs/ 已废弃）

\`\`\`
.pi/
  agents/<name>.md        # 子代理定义（名称、提示词、工具）
  agents/<name>/          # 子代理专属配置（可选）
  extensions/<name>/      # nodejs 扩展（package.json + index.js，依赖随包携带）
  skills/<name>/SKILL.md  # 技能（frontmatter: name/description）
  subagents.json          # 子代理注册表
  models.json             # 模型列表（modelList[].id）
  mcp.json                # MCP 服务器（mcpServers.<name>）
AGENTS.md                 # 项目指令（Agent 的系统提示载体之一）
\`\`\`

## 自检清单（导出前逐项核对）

1. 所有新增文件都在 .pi/ 下（+ 根 AGENTS.md）。
2. 扩展目录含 package.json（name/version/main）与入口文件；代码可被
   node --check 语法校验通过。
3. skills/*/SKILL.md 的 frontmatter 含 name 与 description。
4. models.json / mcp.json 是合法 JSON 且键名与文档一致。
5. 环境依赖已声明（导出后在 manifest.package.dependencies 展示）。
6. 无凭据、无运行态文件（sessions/tmp/bin/cache/plans/.git）。

## 版本与交付

- 语义化版本：能力变更 → minor；修复 → patch；破坏性调整 → major。
- 交付链路：项目菜单「导出配置包」→（管理员）设置 → Agents 管理 → 上传。
  Agents 管理会解析包内容做版本对比、内容清单与文件预览。
`;

const README_MD = `# Agent Builder（内置 Agent 定义）

套用到项目后，该项目内的 Agent 成为 "Agent Builder"：在 .pi/ 下对话式
开发新的 Agent 定义（提示词/扩展代码/技能/子代理/模型/MCP），自检后
经「导出配置包」交付，由管理员上传到 设置 → Agents 管理。

随包附带三份开发技能（.pi/skills/）：pi-extension-dev（扩展开发）、
skill-creator（技能编写）、subagent-creator（子代理设计），按需查阅，
也可作为自己定义里的技能直接复用。

- 依赖：node>=20（扩展代码的运行时）
- 版本：${BUILTIN_AGENT_BUILDER_VERSION}
- 目录纪律：一切配置只落 .pi/（labs/ 已废弃）。
`;

/** Recursively add a local skill tree to the zip under `.pi/skills/<name>/`. */
function addSkillTree(zip: JSZip, localRoot: string, zipRoot: string): number {
  if (!existsSync(localRoot)) return 0;
  let added = 0;
  for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = join(localRoot, entry.name);
    const zipPath = `${zipRoot}/${entry.name}`;
    if (entry.isDirectory()) added += addSkillTree(zip, abs, zipPath);
    else if (entry.isFile()) {
      zip.file(zipPath, readFileSync(abs));
      added += 1;
    }
  }
  return added;
}

export async function builtinAgentBuilderBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        format: { version: 2, exportedAt: new Date().toISOString() },
        package: {
          name: BUILTIN_AGENT_BUILDER_NAME,
          title: "Agent Builder",
          description:
            "对话式开发 Agent 定义：在 .pi/ 下搭建提示词/扩展/技能/子代理/模型/MCP，按规范自检并交付配置包。",
          version: BUILTIN_AGENT_BUILDER_VERSION,
          channel: "stable",
          dependencies: ["node>=20"],
        },
      },
      null,
      2,
    ),
  );
  zip.file("readme.md", README_MD);
  zip.file("agents.md", AGENTS_MD);
  zip.file(".pi/skills/agent-packaging/SKILL.md", PACKAGING_SKILL_MD);
  // Developer skills ride along: .pi/skills/<name>/ with their references/ &
  // scripts/ trees (source: pi-config/agent/skills, shipped with pi-web).
  const skillsRoot = join(process.cwd(), "pi-config", "agent", "skills");
  for (const name of BUILTIN_AGENT_BUILDER_SKILLS) {
    addSkillTree(zip, join(skillsRoot, name), `.pi/skills/${name}`);
  }
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}
