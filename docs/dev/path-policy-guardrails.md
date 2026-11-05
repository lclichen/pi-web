# 路径护栏（策略）：覆盖范围、模式语义与已知逃逸

> 代码：`pi-config/agent/extensions/amedac-core/src/path-guard{,-policy}.ts`
> 设置页：设置 → 策略（`app/api/policy/route.ts`、`components/PolicyConfig.tsx`）
> 测试：`lib/path-guard-policy.test.mjs`、`lib/path-guard.test.mjs`、
> `lib/path-guard-bypass.test.mjs`、`lib/path-guard-e2e.test.mjs`、
> `lib/path-guard-coverage.test.mjs`（2026-11-05 解析分支/模式/决策补全）、
> `lib/path-guard-catastrophic.test.mjs`（灾难命令分类）、
> `lib/tool-manifest.test.mjs`（工具操作层声明完备性门禁）、
> `lib/tool-policy.test.mjs`（模式钳制/MCP 声明）、
> `app/api/policy/policy-route.test.mjs`（试运行 API 契约）

## 1. 它是什么 / 不是什么

- **是**：面向"误操作"的行为护栏。Agent 的写/读/执行在工具调用前被拦截、
  询问或放行，结论可解释（命中了哪条规则），拦截原因作为工具错误回给模型。
- **不是**：安全边界。恶意模型仍可通过变量展开、解释器代码、构建工具等绕过
  bash 静态解析。强隔离由沙箱容器（Apptainer）与 relay 工作区围栏提供；
  护栏的职责是让"手滑/误解指令"变成一条可读的拒绝，而不是防越狱。

## 2. 决策顺序（可解释）

0. **灾难命令分类**（仅 bash/powershell/bg_run 的命令参数；任何策略不可放行，
   不可 ask）：递归删根/home 根/系统树/盘符根、`mkfs`/`dd of=/dev/`、fork bomb、
   `curl|sh`、`$HOME` 变量形式；命中直接 deny（`classifyCatastrophicCommand`，
   2026-11-05 落地）。
1. **自保护清单**（任何策略不可放行）：`.pi/path-policy.json`、
   `.pi/path-policy.decisions.json`、`.pi/path-policy.scope.json`、
   `.pi/guardrail-audit.jsonl`（+`.1` 轮转件）、`.pi/{sessions,tmp,bin,cache,plans}/**`、
   `.pi/{auth,ssh,sandbox-platform}.json`、`.ssh/**`。
2. **deny 规则**：写看 `denyWrite`，读看 `denyRead`（相对 glob / 绝对 glob / `~`）。
3. **持久决策**：`.pi/path-policy.decisions.json` 里"始终允许/拒绝且不再询问"
   的记录，按路径前缀覆盖其子树；多条命中取最新。
4. **allow 规则**：`allowWrite`（默认 `["."]` = 整个工作区）。
5. **工作区外**：读默认放行；写按 `askOnOutsideWrite` 询问或直接拒绝。
   WebUI 弹四选；无人值守（`ctx.hasUI === false`，批量 API/bench）一律拒绝。

## 3. 模式矩阵

| 模式 | 会话 cwd（服务器） | 工具路径空间 | 护栏如何对齐 |
| --- | --- | --- | --- |
| host | 用户选择的服务器目录 | 与 cwd 相同 | 直接判定 |
| quick | 每会话临时工作区 | 与 cwd 相同 | 直接判定 |
| sandbox | 项目 home | 容器内 `/workspace/**` | `.pi/path-policy.scope.json` 把 `/workspace` 映射为项目 home |
| ssh | 项目 home | 远端绝对路径（项目 workdir） | scope 把 workdir 映射为项目 home |
| local-machine | 项目 home | 用户机器路径（项目 workdir；Windows 盘符） | scope 映射；无 workdir 时不做映射 |

- scope 文件由 pi-web 在**新建/恢复会话**时写入（`lib/path-scope.ts`），
  运行态、`0600`、**不导出进配置包**（`DENIED_BASENAMES`）。
- 映射后，相对规则（`.env`、`secrets/**`）在所有模式语义一致；工作区外的
  远端绝对路径保持原样，按"工作区外"处理。
- `workdir` 为 `/`（或缺失）时不写 scope：此时"工作区"没有围栏意义，
  绝对路径走"工作区外"询问/拒绝。

## 4. 工具覆盖

| 工具 | 判定 | 说明 |
| --- | --- | --- |
| `write` / `edit` | 读 + 写 | 路径先按读规则、再按写规则；edit 也读原文件 |
| `read` | 读 | `denyRead` 生效（v1 完全没拦 read，已修） |
| `grep` / `find` / `ls` | 读 | 目录/文件参数命中 denyRead 即拦 |
| `bash` | 写 + 内联兜底 | 见下节 |
| `powershell` | 写 + 内联兜底 | 复用同一套扫描（含 PowerShell 写入 cmdlet） |
| `bg_run` | 写 + 内联兜底 | 经 manifest `commandParams` 与 bash 同管线（2026-11-05 收编；此前完全绕过） |
| `share_file` | 读 | manifest `pathParams`：denyRead 命中即拒绝生成下载链接 |
| MCP / 第三方扩展工具 | **不拦** | 这是已知缺口：它们不走内置工具名。需要强约束时用容器/relay 围栏 |
| 子智能体 | 拦 | 子会话同样从全局 agent dir 加载 amedac-core，工具名一致 |

> 2026-11-05 起拦截名单由 `amedac-core/src/tool-manifest.ts` 驱动（`pathParams` /
> `commandParams`），不再硬编码；新增工具须在 manifest 声明才进入护栏，注册表
> 完备性由 `lib/tool-manifest.test.mjs` 门禁（见 `tool-guardrails-design.md`）。

拦截结果：`{ block: true, reason }` 在 agent 循环里变成 **isError 工具结果**，
模型能看到原因（`lib/path-guard-e2e.test.mjs` 用真实 AgentSession 验证）。
每次判定（allow/ask/deny）追加一行审计到 `<cwd>/.pi/guardrail-audit.jsonl`
（JSONL：ts/tool/cwd/path/action/via；2MB 轮转；写失败静默）。
文案明确要求"不要重复尝试同一路径"，并给出改道建议。

## 5. bash 覆盖范围（v2）

已覆盖：

- 重定向 `> >> >| &>`（含无空格 `>out`；`>|` 曾因裸 `|` 先行切段而漏检，
  2026-11-05 修复并有用例锁定）；`2>&1`、`>&2` 与
  `/dev/null`、`/dev/stdout|stderr|tty`、`/proc/self/fd/*` 忽略；
- 写命令的**全部非 flag 操作数**（v1 只认 `/ ./ ../ ~/` 前缀，
  `rm .env`、`rm -rf secrets` 直接漏检——这是"工作区内锁不住文件"的根因）：
  `rm rmdir unlink mv cp dd truncate shred mkdir touch tee ln install rsync
  chmod chown` + PowerShell `remove-item/move-item/copy-item/new-item/
  set-content/add-content/clear-content/out-file/rename-item`；
- `sed -i`、`dd of=`、`find -delete`、`git -C/clean/reset/checkout/rm`、
  `cp/mv -t`；
- 同一命令串内的 `cd`/`pushd` 追踪（`cd /tmp && rm x` 按 `/tmp` 判定）；
- 引号感知分词；`sudo/env/command/nohup` 等前缀跳过；
- **内联执行兜底**：命令含 `$()`、反引号、heredoc、`sh -c`、`python -c`、
  `node -e`、`eval` 时，对命令原文扫描受保护文件名（`.env`、`*.key`、
  策略文件等）。解释器代码里的路径无法真正解析，这层只兜显式文件名。

未覆盖（有意，文档化而非假装安全）：

- 变量展开后的路径（`DEST=$X; rm "$DEST"`）与未跟踪的子 shell `cd`；
- 解释器/构建工具的间接写入（`python script.py`、`make`、`npm install`）；
- heredoc 内容本身（只扫文件名，不执行语义）；
- MCP / 扩展工具。

## 6. 如何"锁定工作区内的文件"

在项目的 `.pi/path-policy.json` 里追加 deny 规则即可（不需要改代码）：

```json
{
  "version": 1,
  "allowWrite": ["."],
  "denyWrite": ["locked/**", "config/prod.*", "*.db"],
  "denyRead": ["secrets/**", ".env"],
  "askOnOutsideWrite": true
}
```

- 目录模式覆盖整棵子树；`**` 任意深度，`*` 段内任意。
- 验证：设置 → 策略 → **试运行**，输入 `locked/a.txt`（写）或
  `rm -rf locked`（bash 命令），用与护栏完全相同的判定看结果。
- 编辑权限：Host 目录管理员可编辑；sandbox/ssh/local-machine 项目默认
  普通用户只读（策略随配置包分发，防止终端用户自行放开），**服务器管理员
  可在项目内调整**。决策记录（"不再询问"）任何模式都可查看与移除。
- 分发：deny 规则与 deny 决策随配置包导出；接收端同样生效。

## 7. 已知边界与后续

- `bash` 的 `cd` 跟踪只在单条命令内有效；跨多次工具调用的 `cd` 不保留
  （每次调用都是新 shell）。
- 若确实需要"绝对不可写"，应使用沙箱只读挂载/文件权限；护栏只保证
  "Agent 的正常工具路径会被检查"。
