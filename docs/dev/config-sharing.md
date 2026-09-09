# 配置分享功能：使用介绍与现状盘点

本文覆盖三套互相配合的机制：**项目配置包**（点对点分享）、**预置配置模板**
（管理员统一分发）、**Host 目录配置包**（服务器目录版）。最后是已知不足清单。

## 一、项目配置包（导出 / 导入）— 已实现

**是什么**：把一个项目的 `.pi/` 配置（agents/skills/extensions/models.json/
AGENTS.md）与 `labs/` 打成一个 zip，在项目之间、机器之间转移。

**怎么用**：
1. 项目右键（或 ⋮ 菜单）→「导出配置包…」→ 下载 `<项目名>-config.zip`；
2. 目标项目 ⋮ 菜单 →「导入项目配置…」→ 拖入或选择 zip → 平台报告
   新增/覆盖 文件数与清单；
3. Host 目录（admin）同样支持：目录组 ⋮ 菜单有相同两项。

**安全边界（重要）**：
- 凭证永不进包：`auth.json`、`ssh.json`、`sandbox-platform.json` 在导出时
  被剥离（DENIED_BASENAMES），导入端遇到也静默剥离；
- 路径穿越（`../`）与超 200MB 的包直接拒绝，原配置不受影响；
- `.pi/plans/`、`sessions/` 等运行时状态不进包（DENIED_SEGMENTS）；
- 包内可以携带 `node_modules`（离线部署场景，extensions 依赖随包恢复）。

## 二、预置配置模板（presetBundle）— 后端已实现，管理 UI 缺失

**是什么**：管理员把一组标准配置（.pi/ + labs/）作为 zip 上传到平台
（`data/config-bundles/<name>.zip`），普通用户新建项目时从下拉框选择，
项目 home 创建时自动套用（`createProject` 的 `presetBundle` 路径）。

**现状**：
- ✅ 存储 + 校验（`lib/config-bundles-store.ts`：命名规则、zip 完整性、
  meta.json 索引）；
- ✅ API：`GET /api/bundles`（登录用户可列出——向导需要）、
  `POST /api/bundles`（admin 上传，multipart file/name/description）；
- ✅ 向导接入：`RemoteConnectWizard`（新建项目向导）有模板下拉框，
  创建请求带 `presetBundle`；
- ✅ 项目创建端：`createProject` 在 seed 之前 `applyBundleToDirectory`
  （整包 seed 优先级更高——"复制项目"语义）。
- ❌ **缺管理 UI**：上传/删除模板目前只能 curl（见下方命令）；
- ❌ **缺 DELETE 端点**：`deleteBundle()` 函数存在但 `/api/bundles`
  没有挂 DELETE 路由；
- ❌ **模板不可在项目创建后套用**：presetBundle 只在 createProject 生效；
  已有项目要用"导入项目配置"手动导入。

**管理员当前操作方式（curl）**：

```bash
# 上传模板（name 会成为下拉框里的模板名）
curl -X POST http://<host>:30141/api/bundles \
  -H "Cookie: pi_web_sid=<admin会话>" \
  -F "file=@my-standard-config.zip" -F "name=standard-lab" \
  -F "description=标准实验环境配置"

# 列出（登录用户均可）
curl http://<host>:30141/api/bundles -H "Cookie: pi_web_sid=<sid>"
```

删除需要直接删文件（`data/config-bundles/<name>.zip` + meta.json 条目），
等 DELETE 端点补上后走 API。

## 三、与"快速会话模板"的关系

快速会话模板（`data/quick-templates.json`，设置 → 快速会话模板）面向
**无工作区的问答会话**，管的是模型/系统提示词/MCP 白名单；配置模板
（config-bundles）面向**有工作区的项目**，管的是 .pi/ 目录与 labs。
两套模板互不冲突：前者是轻量 JSON 记录，后者是完整 zip。

## 四、已知不足与建议（按优先级）

### P1 — 两种启动模式下配置包能力不对齐

| 能力 | Host 目录项目 | 沙箱/本机/SSH 项目 |
|---|---|---|
| 导出配置包 | ✅（目录组菜单） | ✅（项目菜单） |
| 导入项目配置 | ✅ | ✅ |
| 创建时选模板 | ❌（Host 目录无向导） | ✅（向导下拉框） |
| 创建后套用模板 | ❌（只能导入 zip） | ❌（只能导入 zip） |

建议：给项目 ⋮ 菜单加「套用配置模板…」（列出 bundles，选中即
applyBundleToDirectory 到该项目 home——后端函数已存在，只差一条 API
和菜单项）。

### P1 — 模板管理无 UI + 无删除 API

见上文。建议：设置 → 插件 旁边加「配置模板」分区（admin），列出/
上传/删除 bundles；`/api/bundles` 补 `DELETE ?name=`（admin）。

### P2 — 权限矩阵说明（现状即设计）

- 导出/导入**项目**配置：项目属主（+admin）；
- 导出/导入 **Host 目录**配置：仅 admin（Host 目录本身就是 admin-only）；
- 上传/删除**预置模板**：仅 admin；**列出**：所有登录用户（向导需要）；
- 导入的配置落在项目 home 内，受项目隔离保护；但注意导入包里的
  extensions 会在该项目下次会话启动时执行（受项目信任门控——未信任
  的项目会先弹信任提示）。

### P2 — 包内容审计提示

导入端只剥离已知凭证文件名。如果 zip 里带恶意 extension 脚本，隔离
依赖项目信任机制（用户必须先信任才执行）。分享来路不明的包时应先解包
检查 `.pi/extensions/`。

### P3 — 无版本/签名

配置包没有版本号与签名，无法判断新旧、无法防篡改。离线内网场景可接受；
若未来跨信任域分发，需要加 manifest 签名。

## 五、与快速会话模式的权限关系

快速会话（quick 模式）没有工作区，因此**不参与**配置包体系——它的
"模板"是 quick-templates.json（admin 管理），套用即改系统提示词/模型/
MCP 白名单，不落任何文件到用户侧。这也是刻意设计：快速会话的可定制面
收敛到模板三要素，避免把文件系统语义（.pi/ 发现、项目信任）带进一个
本应"零工作区"的模式。
