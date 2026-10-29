# Agent Builder 端到端 Demo：从零创建一个可交付的「代码巡检 Agent」

> 目标：15~20 分钟内演示完整闭环 —— **用内置 Agent Builder 创建覆盖全部模块类型的
> Agent → 实际跑一次真实任务 → 导出配置包 → 加密（.apkg）→ 导入 Agents 管理 →
> 套用到新项目交付 → 迭代新版本**。
>
> 成品参照树在 [`examples/agent-builder-demo/`](../../examples/agent-builder-demo/)：
> 演示既可以"让 Builder 按对话生成"（完整叙事），也可以直接复制该树（快速通道，
> 应对现场时间紧张/网络波动）。

## 一、前置条件（演示前 5 分钟核对）

| 项 | 要求 | 核对方式 |
|---|---|---|
| pi-web 版本 | 含 Agents 管理 + 内置 agent-builder **1.1.1**（带开发技能库） | 设置 → Agents 管理 列表里 agent-builder 版本为 1.1.1 |
| 模型 | 演示账号至少有一个可用模型 | 会话里随意发一句话能出结果 |
| 示例仓库 | 任意含 git 历史与源码的目录（推荐就用 pi-web 仓库副本或一个中等规模项目） | `git log --oneline -1` 有输出 |
| 加密工具 | `bin/apkg-publisher(.exe)` 或 `PI_WEB_APKG_TOOL` 可用 | `bin/apkg-publisher.exe --help` 出用法 |
| MCP 信任 | Host 会话首次加载 `audit-memo` 需在 设置 → MCP 允许 | 演示前先信任一次，正式演示不打断 |

## 二、模块覆盖矩阵（"全面包含各类模块"的落点）

| 模块 | 文件 | 演示时的看点 |
|---|---|---|
| 系统提示 | `AGENTS.md` | 角色/工作流/报告格式三件事 —— 换成别的 Agent 只需改这一份 |
| 包声明 | `.pi/bundle.json` | name/version/channel/**dependencies** → 导出自动并入 manifest.package，Agents 管理"依赖"区可见 |
| 技能 | `.pi/skills/code-audit-rules/SKILL.md` + `references/checklist.md` | 触发词只在需要时加载；references 是渐进披露（打开文件面板对比两个文件） |
| 子代理 | `.pi/agents/coverage-analyst.md` | frontmatter（description/tools/max_turns/thinking）+ 方法论；Agent 工具自动发现 |
| 扩展 | `.pi/extensions/audit-collect/`（package.json + index.js） | 注册自定义工具 `audit_collect`（git 统计 + TODO 扫描 + 大文件 Top，零依赖） |
| MCP | `.pi/mcp.json` + `.pi/mcp/memo-server.mjs` | 零依赖 stdio MCP：`memo_save`/`memo_list`，记录写 `.pi/audit-memos.jsonl` |

> 模型不在参照树内。会话用哪个模型由部署管理员在 设置 → 模型 配置；项目里的
> `.pi/models.json` 会覆盖该项目会话的模型运行时，带错格式（如历史上的
> `modelList[]`）会让会话模型列表变空，因此 Agent 包一律不带 models.json。

## 三、演示脚本（分幕，含操作与预期）

### 第 0 幕 · 准备（1 min）

1. 新开一个 **Host 模式**项目，工作区指向空目录（如 `~/demo/agent-lab`）。
2. 进入 设置 → Agents 管理，指给观众看：内置 `agent-builder`（1.1.1，保护不可删）。
3. 说明：Agent Builder 是"造 Agent 的 Agent"，它的能力来自随包技能库
   （pi-extension-dev / skill-creator / subagent-creator / agent-packaging）。

### 第 1 幕 · 套用 Agent Builder（1 min）

1. Agents 管理 → agent-builder → **套用到项目** 选择刚建的 Host 项目。
   （Host 套用要求目标没有 `.pi/`，空项目正好；若 409 说明目录已有配置。）
2. 打开该项目的新会话：系统提示显示四步工作流 + 技能库说明 —— 这就是"可编辑的
   构建器本身"。

### 第 2 幕 · 对话式创建代码巡检 Agent（6~8 min，完整叙事）

按顺序把下面的话发给 Builder（每步的验证点写在括号里）：

1. > 我要做一个"代码巡检 Agent"：对任意仓库输出可进评审纪要的巡检报告，
    > 覆盖安全/可维护性/测试/变更面四个维度。先给方案，我确认后再动手。
    （Builder 读技能、给方案；强调它先确认再写文件）
2. （确认后）> 按方案创建：先写根 AGENTS.md 和 .pi/bundle.json（name=code-audit,
    > version=1.0.0, dependencies 含 node>=20 与 git）。
    （文件面板逐个打开核对；`.pi/bundle.json` 是包名/版本/依赖的唯一声明处）
3. > 加技能 code-audit-rules：SKILL.md 给维度与报告纪律，references/checklist.md
    > 放逐项清单（渐进披露）。
4. > 加子代理 coverage-analyst：只做覆盖率缺口分析，tools 限 read/grep/find/bash。
    （打开 .pi/agents/coverage-analyst.md 展示 frontmatter）
5. > 加扩展 audit-collect：注册工具 audit_collect，参数 since/topFiles，输出
    > git 变更统计 + TODO/FIXME 分布 + 大文件 TopN，零依赖。
    （让 Builder 按 pi-extension-dev 技能自查；node --check 通过）
6. > 加 MCP：.pi/mcp.json 挂 audit-memo，服务器脚本放 .pi/mcp/memo-server.mjs
    > （零依赖 stdio，工具 memo_save/memo_list）。
7. > 最后按 agent-packaging 自检清单逐条核对，列出结论。

> ⏱ 现场时间紧张就切**快速通道**：把 `examples/agent-builder-demo/` 的
> `AGENTS.md` 和 `.pi/` 复制进项目 home，然后只演示第 3 幕起的验证/交付；
> "可编辑"用第 8 幕的改技能+改版本号来体现。

### 第 3 幕 · 实际可用验证（3~4 min）

把示例仓库拷到项目工作区（或直接用工作区里的现有仓库），发送：

> 巡检当前工作区，按报告格式输出；记录一条 memo。

预期轨迹（逐条指给观众看）：

1. agent 读 `code-audit-rules` 技能（SKILL.md，需要细节再读 references/checklist.md）；
2. 调用 **`audit_collect`** —— 工具卡片里能看到 git 统计/TODO 分布/大文件 Top；
3. 派发 **`coverage-analyst`** 子代理（智能体面板出现运行条目），返回覆盖率缺口表；
4. 调用 MCP 工具 **`memo_save`**（首次需已信任 audit-memo），落一条 JSONL；
5. 输出固定结构的巡检报告（结论/事实概览/风险清单/覆盖率缺口/下一步）。

这就是"**实际可用**"的证据：自定义工具 + 技能 + 子代理 + MCP 四类运行时模块
全部被真实调用。

### 第 4 幕 · 打包导出（2 min）

1. 项目菜单 → **导出配置包**（生成 zip，凭证自动剥离）。
2. 观众看点：包内含 `AGENTS.md` + `.pi/**`（bundle.json/技能/子代理/扩展/MCP）；
   `manifest.package` 里 name=code-audit、version=1.0.0、dependencies 来自
   `.pi/bundle.json`（本轮新支持——导出器把这个声明并入 manifest）。
3. （可选）指给观众看：`.pi/audit-memos.jsonl` 是演示运行产物，正式交付前
   可以删掉再导出——导出会把它一起带走。

### 第 5 幕 · 加密为 .apkg（2 min）

```bash
# 首次：生成一代 KEK（密钥仓请放安全位置，代际不混用）
bin/apkg-publisher.exe keys new --keys data/apkg-keys.json --id demo-gen1

# 加密打包（--harden 会 bundle+minify 混淆 .pi/extensions 里的扩展源码）
bin/apkg-publisher.exe pack \
  --in  code-audit.zip \
  --out code-audit-1.0.0.apkg \
  --keys data/apkg-keys.json --key-id demo-gen1 \
  --name code-audit --title "代码巡检 Agent" --version 1.0.0 \
  --buyer demo-customer --max-imports 20 --harden
```

要点：密文含明文展示元信息（Agents 管理不解密也能列名/版本）；`--max-imports`
限制导入次数；`--buyer` 写水印便于溯源。**解密只在导入时由服务端经
`apkg-publisher open`（纯解密预言机）完成**，pi-web 仓内无加解密代码。

### 第 6 幕 · 导入 Agents 管理（2 min）

1. 设置 → Agents 管理 → **上传配置包** → 选择 `code-audit-1.0.0.apkg`。
2. 看点：列表显示名称/版本/依赖/大小；详情页有内容清单（扩展/技能/子代理/MCP
   分类计数）与文件预览（加密包预览经解密预言机，不落明文到磁盘）。
3. 说明保护策略：agent-builder 内置包不可删改；上传的同名包按版本对比。

### 第 7 幕 · 交付闭环（2 min）

1. 再建一个 **Host 项目**（空目录）。
2. Agents 管理 → code-audit → **套用到项目** → 打开会话。
3. 随便发一句"巡检当前工作区"：行为与源项目一致（技能/子代理/扩展/MCP 都在）。
4. 反例演示：在这个项目里试"导出配置包" → **403 禁止再导出**
   （`.pi/.bundle-lock.json` 标记加密来源），这就是"加密包防二次分发"。

### 第 8 幕 · 迭代与版本（1 min）

1. 回到源项目，改 `.pi/skills/code-audit-rules/references/checklist.md` 加一条检查项，
   并把 `.pi/bundle.json` 的 version 改成 1.0.1。
2. 再导出 → 再加密 → 上传：Agents 管理里出现两个版本，详情可对比内容清单。
3. 说明：线上的加密包按 `--key-id` 代际与导入计数管理，吊销一代不影响其他代。

## 四、命令速查

```bash
# 明文包（产品内导出即可，此命令仅用于离线复现导出格式）
node -e "import('./lib/project-config-bundle.ts').then(...)"   # 详细用法见 lib 测试

# 加密
bin/apkg-publisher.exe pack --in <zip> --out <apkg> --keys <keys.json> \
  [--key-id <gen>] [--name n] [--title t] [--version v] \
  [--buyer 客户] [--expires YYYY-MM-DD] [--max-imports N] [--harden]

# 解密（排障/离线校验用；导入流程由服务端自动调用）
bin/apkg-publisher.exe open --in <apkg> --keys <keys.json> --out <zip>

# 密钥代管理
bin/apkg-publisher.exe keys list --keys <keys.json>
bin/apkg-publisher.exe keys new  --keys <keys.json> --id <gen>
```

## 五、常见问题

- **MCP 没被调用**：Host 会话首启时 MCP 服务器需要信任（设置 → MCP）；
  或 `node` 不在会话 PATH 里——`mcp.json` 的 command 可写绝对路径。
- **`audit_collect` 报非 git 仓库**：工作区不是 git 仓库时变更统计跳过（属预期），
  换一个示例仓库或看 TODO/大文件部分。
- **Host 套用 409**：目标目录已有 `.pi/`。演示用空目录；既有项目请用"项目导入"。
- **上传 .apkg 提示未配备解密组件**：`PI_WEB_APKG_TOOL` 未指向可用二进制，
  或 `bin/apkg-publisher` 不在 cwd/数据目录——按 commercial-protection.md 配置。
- **模型选不到**：确认部署的 设置 → 模型 里至少有一个可用模型；**不要**在项目
  `.pi/` 下补 models.json——它会覆盖全局模型运行时，格式不一致时会直接清空
  会话的模型列表。

## 六、验收清单

- [ ] Agents 管理可见 agent-builder 1.1.1，能套用到空 Host 项目
- [ ] 成品树六类模块齐全（bundle.json / AGENTS.md / 技能+references / 子代理 / 扩展 / MCP），且不含 models.json
- [ ] 会话实测：技能被读、audit_collect 有真实输出、coverage-analyst 被派发、memo_save 落盘
- [ ] 导出 zip 的 manifest.package 带 name/version/dependencies（来自 .pi/bundle.json）
- [ ] apkg 加密成功（--harden 后扩展源码不可直接读）
- [ ] 上传后在 Agents 管理可看内容清单与文件预览
- [ ] 套用到新项目行为一致；加密包导入的项目再导出返回 403
- [ ] 版本迭代 1.0.0 → 1.0.1 后上传可见两版
