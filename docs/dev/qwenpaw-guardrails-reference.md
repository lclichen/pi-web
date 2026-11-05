# QwenPaw 行为护栏安全策略参照分析

> 分析对象：`HarnessReference/QwenPaw`（阿里 AgentScope 出品的个人 AI 助手，Python，
> 安全相关代码约 2.3 万行，分布于 `src/qwenpaw/{security,sandbox,governance}/`）。
> 本文是 2026-11-05 的代码级调研结论，用于 pi-web 工具护栏设计参照
> （配套设计见 `tool-guardrails-design.md`）。
> 引用格式：QwenPaw 仓库内 `file:line`。

## 0. 总体架构：五层防御 + 一条核心设计原则

```
工具调用 (agentscope PermissionEngine: tool.check_permissions)
   │
   ▼
governance/  决策管线（主路径）
   ├─ Phase 0  工具注册表检查（未注册 → DENY）
   ├─ Phase 1  深度扫描（敏感路径/危险模式/shell 逃逸 → findings）
   ├─ Phase 2  规则匹配（builtin → user，first-match-wins）
   ├─ Phase 3  execution_level 兜底（无命中时的默认动作）
   ▼
GovernanceAction: ALLOW / DENY / ASK / SANDBOX_FALLBACK   ← 四值决策
   │
   ├─ ASK ─────────→ ApprovalService（阻塞式人工审批，Future + 300s 超时=拒绝）
   ├─ SANDBOX_FALLBACK → 编译 SandboxConfig → sandbox/ 内核级沙盒执行
   └─ JEV 模式 ────→ decision_model.py（LLM 二次复核，只可放宽不可推翻 DENY）

security/    检测与静态分析（tool_guard 四 guardian + skill_scanner + secret_store）
sandbox/     内核级执行隔离（bwrap/Landlock/Seatbelt/Windows 三后端）
```

**核心设计原则（最值得借鉴）：检测与决策彻底分离。** Guardian/detector 只产出带
severity 的 `GuardFinding`（证据），不决定 allow/deny；决策层用
`severity × execution_level` 映射到四值动作。同一套检测核心可服务不同策略档位，
ACP 层还能直接复用底层原语做硬阻断（互不耦合）。

## 1. 决策管线（governance/）

### 1.1 四值动作与评估阶段

`GovernanceAction`（`governance/policy.py:39`）：`ALLOW / DENY / ASK /
SANDBOX_FALLBACK`——**shell 类工具无规则命中时默认"进沙盒执行"而非放行**。
`GovernancePolicy.evaluate`（policy.py:702-873）：

- **Phase 0**：工具必须在 `tool_registry` 注册（声明 `tool_type:
  file/network/shell/internal` + `target_param`），**未注册直接 DENY**
  （tool_registry.py:487 有治理缺口自检，runtime 收集到但未注册的工具会报错）
- **Phase 1**：三个检测器（detectors.py = tool_guard guardian 的纯函数版）；
  命中 auto-deny 规则 ID（默认仅灾难性命令）立即 DENY
- **Phase 2**：builtin 规则（代码内置，约 45 条敏感资源 ASK + 灾难 DENY）→
  user 规则，first-match-wins，`add_rule` 新规则插头部（policy.py:1116）
- **Phase 3**：`execution_level` 作为严重度阈值兜底
  （policy.py:987 `_apply_execution_level_fallback`）

### 1.2 规则表达与防篡改

- 统一格式 `"ToolName(pattern)"`（`Bash(git *)`、`*(.ssh/**)`）；
  `grantee`（`*` 或 agent_id）+ `duration`（session/permanent）
- **session 规则 fail-closed**：请求缺 session_id 时拒绝匹配（policy.py:172-180）
- file 类用 `wcmatch.glob`（GLOBSTAR/BRACE/NEGATE），shell 用 fnmatch；
  glob 之外再补正则检测规则（`_SHELL_DANGER_PATTERNS` policy.py:275）
- **builtin 规则只存代码**：policy.yaml 里的 `builtin_rules` 键被显式忽略并告警
  （policy.py:1289-1302）；策略文件存在 workspace 外
  （`governance/<名>_<hash>/policy.yaml`，resource_governor.py:104）
- `applied_migrations`（policy.py:1315）：用户删掉的默认规则不会在下次加载复活
- glob 元字符转义（policy.py:1828）：目录名含 `[1]`/`{a,b}` 时正确转义，
  注释给出具体错授权案例

### 1.3 execution_level 五档

`security/tool_guard/execution_level.py:15`：

| 档 | 行为 |
| --- | --- |
| STRICT | 所有工具一律审批（无 findings 时合成 INFO finding 生成审批卡） |
| SMART | INFO/LOW 放行，MEDIUM/HIGH/CRITICAL 审批（推荐默认） |
| JEV | SMART + LLM 决策模型对"确定性放行"二次复核；模型不可用 fail-closed 转 ASK |
| AUTO | 仅 guarded_tools 范围内检查（无效配置值的兜底档——已知弱点） |
| OFF | 完全关闭 |

解析优先级：session 级覆盖 > agent 配置；**无 agent_id 时 bypass**（已知 fail-open 弱点，
runtime/tool_guard.py:113）。

## 2. 检测层（security/tool_guard/）

### 2.1 Guardian 架构

`BaseToolGuardian`（guardians/__init__.py:17）：`name` + `always_run` +
`guard(tool_name, params) -> list[GuardFinding]`。**`always_run=True` 的 guardian
即使工具被移出守护范围也照跑**（engine.py:260-264）——防配置放宽后灾难检查失效。
引擎顺序执行全部 guardian、不短路；单个 guardian 异常 fail-open 记入
`guardians_failed`（engine.py:266-280，已知弱点）。

| Guardian | 职责 |
| --- | --- |
| SharedSafety | 灾难命令分类：catastrophic → CRITICAL + auto-deny；system_power → 仅审批（rule_guardian.py:682） |
| FilePath | 敏感文件黑名单（`.secret` 目录 + config 扩充），三级扫描：shell 抽路径 / 文件工具查特定参数 / 其他工具扫一切"像路径"的参数（file_guardian.py:461-512） |
| RuleBased | YAML 规则匹配 + **rm 目标提取增强**：剥 `\rm`/`$(which rm)` 等逃逸形式后逐目标 resolve 判工作区越界（rule_guardian.py:209-345） |
| ShellEvasion | **引号感知状态机**（`_QuoteState` 逐字符）7 项检查防解析差异绕过（shell_evasion_guardian.py:505-513）：命令替换（反引号/`$()`/进程替换/Zsh `=(cmd)`）、ANSI-C `$'\x2d'` 混淆、反斜杠转义空白/操作符、换行藏命令、注释内引号失步、引号内换行+# 行 |

**已知弱点：ShellEvasion 七项检查默认全关**（未配置的键默认 disabled，
shell_evasion_guardian.py:520）——核心防线 opt-in。

### 2.2 safety_checks.py——共享原语层（1107 行，质量最高）

被 guardian、governance Phase 1、ACP 硬阻断（agents/acp/permissions.py:414-441）
三处复用：

- **灾难命令双通道分类**：① 正则字面匹配（`rm -r` + 灾难目标：`/`、home 根、
  系统树、`C:\Users`、`format X:`、fork bomb、mkfs/dd 限定命令位置防误报；
  WSL/Git Bash/Cygwin/PowerShell 变体全覆盖）；② **resolve 归一化通道**——
  正则漏掉的拼写（`C:/Users`、`~/..`）经 expand→normalize→resolve 后按路径
  parts 分类。注释把每个设计决定对应的真实 bypass 写清楚（如 #5090
  `rm -rf ${HOME}` 漏报修复：`${RM}` 类变量只用于检测、不用于目标提取）
- **先 expand `~/$HOME` 再 normpath 的顺序约束**：否则 `~/..` 折叠成 `.` 逃逸
  （safety_checks.py:683-714 注释）
- **`is_path_outside_boundary`**（:1065）：用 `PurePath.relative_to` 而非字符串
  前缀（防 `/foo/bar_evil` 兄弟目录前缀绕过）；Windows 跨盘号正确处理
- 间接 rm 解包（`$(which rm)`/`` `which rm` ``/`${RM:-rm}` → 重写为 rm 再分类）；
  temp 树豁免；macOS firmlink 剥离

### 2.3 规则文件格式（dangerous_shell_commands.yaml，21 条）

```yaml
- id: TOOL_CMD_PIPE_TO_SHELL
  tools: [execute_shell_command]
  params: [command]
  category: code_execution
  severity: CRITICAL
  patterns:
    - "\\b(curl|wget)\\b\\s+.*\\|.*\\b(bash|sh|zsh|ash|dash)\\b"
  description: "Detects 'curl | bash' patterns..."
  remediation: "Confirm with user. Agents should inspect scripts before executing them."
```

字段：`id/tools/params/category/severity/patterns/exclude_patterns/description/
remediation`；正则预编译 IGNORECASE；exclude 命中即整体跳过。
规则文件即配置：YAML 签名 + config 自定义/禁用规则 + 热重载。

## 3. 审批层

### 3.1 阻塞式审批状态机

`PendingApproval`（app/approvals/service.py:70）：`pending → approved/denied/
timeout/cancelled/superseded`。工具调用内 `asyncio.shield(Future)` 阻塞等待
（默认 300s），**超时=拒绝**。决议入口：HTTP `POST /approval/{approve,deny}` +
IM 频道 `/approval` 命令；前端复用既有轮询通道。身份策略校验
（EXACT_REQUESTER 五元组 + admin 豁免），支持跨 session/子 agent 路由。

### 3.2 三个精彩细节

1. **`_NO_RETRY_INSTRUCTION`**（runtime/tool_guard.py:130-147）：所有拒绝路径
   在 ToolResult 注入统一系统指令——"此拒绝是终局的，不得变参重试或绕路完成"。
   直击 agent 拒绝疲劳问题（pi-web path-guard 已采用同思路）
2. **审批粒度分层**：builtin 规则触发的 ASK 批准后**不记规则**（下次再问）；
   user 规则触发的批准固化为 **session 级** ALLOW；LLM 决策模型的批准仅单次有效
   （resource_governor.py:551）
3. **LLM 泛化审批以"LLM 不可信"为前提**（generalize.py）：用户批准 `git status`
   后让 LLM 生成保守 glob（`git *`）供未来免问，三重验证缺一不可——非裸通配符 /
   模式必须仍匹配原 target / **锚点保持**（shell 首 token 必须字面前缀）；
   rm/dd/sudo 等 16 个破坏性命令永不泛化；6s 硬超时，失败回退精确匹配

### 3.3 LLM 决策模型（decision_model.py）

JEV 档下对"确定性护栏已放行"的调用做 LLM 复核。铁律：**deny-overrides——
LLM 只能放宽确定性放行，永远不能推翻确定性拒绝；自身任何异常 fail-to-approval**
（:560-576）。发模型前有披露过滤器（密钥字面量/敏感路径/凭据参数名），
只发工具 target 不发对话内容。判定是概率阈值而非连续评分。只读快路径要求工具
显式声明 `decision_model_local_read` 元数据，且校验函数 `__module__/__name__`
防冒领。

## 4. 沙盒层（sandbox/）

### 4.1 平台矩阵

| 平台 | 机制 | 特点 |
| --- | --- | --- |
| Linux 首选 | bubblewrap（mount namespace） | deny_paths 用 `--tmpfs` 遮罩、单文件 `--ro-bind /dev/null`；**无 `--unshare-net`，网络全开** |
| Linux 回退 | Landlock LSM（ctypes syscall） | 桥接脚本（父进程受限后无法再 fork）；deny_paths 靠 HOME 一级目录枚举，**枚举失败 fail-closed**；端口级网络需 ABI v4 |
| macOS | Seatbelt `sandbox-exec -p` | `(deny default)` 起步 allow-list 编 profile；admin-only 逃生舱逐字嵌入（有注入转义）；**Apple 已弃用该机制** |
| Windows 强隔离 | AppContainer | 默认全拒 + 容器 SID ACE；网络=能力 SID，`[]` 才真封网 |
| Windows admin | 专用本地账号 + WRITE_RESTRICTED token + WFP 防火墙按用户 SID 封网 | 唯一网络 fail-closed 后端 |
| Windows 非 admin | 受限令牌（随机伪造 capability SID） | **最弱**：读全开、deny_paths 不可执行、"封网"只是代理环境变量 |

### 4.2 两个制度级设计（最值得抄）

1. **`_ENFORCED_FIELDS` 诚实声明机制**（sandbox/config.py:325）：每个后端用
   frozenset 自声明"真正执行了哪些配置字段"，构造时
   `report_unenforced_config()` 把没执行的约束打 WARNING（安全边界字段）。
   空默认值=新后端默认全告警。制度性堵死"声称保护强度 vs 实际执行强度脱节"。
   QwenPaw 自己也靠它诚实暴露：`max_processes/max_memory_mb` 无后端执行、
   `env_mode=allowlist` 未实现（**API key 默认全量泄入沙盒子进程**——已知边界）
2. **`runtime_boundary.py` 内核态验证**：不用环境变量自证隔离，读
   `/proc/self/uid_map` + CapEff + mountinfo（Linux）、`sandbox_check`（macOS）、
   `TokenIsAppContainer`（Windows）实证继承的隔离成立，fail-closed

### 4.3 集成与降级

- 治理决策 SANDBOX_FALLBACK → 编译 SandboxConfig（mounts 从规则推导：读工具→ro、
  写工具→rw、workspace 恒 rw；deny_paths 默认约 20 条凭证路径纵深防御）
- shell 工具拿到非空 sandbox_config 才进沙盒，为 None 时 debug 日志后**直接裸跑
  （fail-open）**；唯一 fail-closed 的是 REPL 工具（无沙盒拒绝运行）
- 沙盒违规（stderr 正则启发式）→ DENIED ToolChunk；审批通过后去沙盒原样重试
- 沙盒不可用时 SANDBOX_FALLBACK 降级为 ALLOW（Phase 0-2 检查仍在，注释详述取舍）

## 5. Skill Scanner（security/skill_scanner/）

### 5.1 架构与时序

编排器 `SkillScanner` + 分析器接口 `BaseAnalyzer`（预留 AST/LLM 插件位）+
唯一实现 `PatternAnalyzer`（YAML 正则签名逐行匹配）。扫描**整个 skill 包目录**。

扫描时机=安装/导入/原地编辑/改名/**启用**时，无运行时扫描。关键事务模式：
**暂存目录 → 扫描 → 通过才原子落盘**；**enable 时强制重扫**（防安装后篡改）。
结果出路：mode=`block`（CRITICAL/HIGH 抛 SkillScanError，HTTP 422）/`warn`/`off`。
白名单 = `skill_name + SHA-256 内容哈希` 锚定；阻断/告警历史持久化 JSON。

### 5.2 规则覆盖

8 个签名 YAML 共 42 条：命令注入（12）、数据外泄（7，正则含 webhook/pastebin/
discord 域名）、硬编码密钥（8：AWS/Stripe/GitHub/PEM）、混淆（4）、
**提示注入（5，仅 markdown，中英双语——"忽略之前指令"/"不要告诉用户"都有中文
模式）**、社工（2，冒充官方）、供应链（1，隐藏 dotfile 夹带代码）、
未授权工具使用（3）。

误报豁免四层：规则内 exclude_patterns → 策略级已知测试凭据/占位符 →
规则作用域（docs/examples/tests 目录豁免）→ `rule:file:line` 去重。
正则长度上限 1000 防 ReDoS；文件数/大小双限；symlink resolve 防穿越。

### 5.3 关键弱点

- **纯 regex，零 AST/数据流**；一批死规则（`manifest`/`binary` 文件类型永不产出，
  3 条规则永不触发；`.svg` 被当 inert 跳过使 SVG 规则失效）
- **扫描超时 fail-open 放行**；超文件数上限部分静默不扫；
  **归档完全不透明**（zip 整体跳过）
- exclude_patterns 可被反向利用（同行塞 `example` 注释即逃逸）
- 无作者签名链，信任=用户手动白名单

## 6. 配套基础设施

- **secret_store.py**：落盘静态加密（Fernet，`ENC:` 前缀），主钥 OS keyring
  （10s daemon 线程超时防挂死）→ 0600 文件回退；与"禁读密钥目录"构成双层防御
- **audit.py**：SQLite 单文件（WAL）记 5W 审计，写失败只记日志不阻塞决策；
  **无防篡改**（无哈希链/签名），100k 自动清理可被审计洪水挤掉历史

## 7. 对 pi-web 的映射（结论）

| pi-web 需要 | 借什么 | 不借什么 |
| --- | --- | --- |
| 四/五模式工具护栏 | 管线骨架：findings(severity) → 规则 → 档位 → 动作；**工具注册表 + 未声明即拒**（Phase 0）满足"新工具声明操作层"需求 | LLM 决策模型/审批泛化（pi-web 无阻塞式审批 UI 通道，先不做） |
| 命令内容检测 | safety_checks 灾难命令双通道分类 + 引号感知逃逸检测思路；修掉"evasion 默认全关" | — |
| 文件系统沙盒 | `_ENFORCED_FIELDS` 诚实声明机制；env/网络做成一等公民（QwenPaw 的两个已知反面教训） | 自研内核沙盒（pi-web 已有 Apptainer 平台） |
| Skill 安全分析（低优） | 暂存+扫描通过才落盘、enable 重扫、内容哈希白名单、双语提示注入规则 | 纯 regex 形态、超时 fail-open |
| 路径护栏测试 | safety_checks 注释里的真实 bypass 案例清单（`~/..` 折叠、`${RM}` 检测/提取分离、兄弟目录前缀）做对抗测试素材 | — |
