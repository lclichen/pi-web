# pi-web 批量 QA 测试套件（Python，纯标准库）

通过 **batch API**（host / sandbox）与**标准会话 API**（ssh / local-machine /
quick——batch API 尚未支持这三种模式）批量执行功能测试，覆盖
**plan / todo / 子智能体 / MCP**，支持 **模型 × 思考档位** 组合矩阵，
并发固定 4（与服务端 `PI_WEB_BATCH_MAX_CONCURRENT=4` 对齐，客户端同样限 4）。

## 文件

| 文件 | 作用 |
|---|---|
| `piweb_client.py` | HTTP 客户端：BatchTransport（API key 认证）/ SessionTransport（web 登录）+ 证物提取 |
| `testcases.py` | 提示词设计与矩阵生成（模式 × 功能 × 模型组合；占位未填自动跳过） |
| `run_matrix.py` | 执行器 + 报告生成（JSON + Markdown，含 UI 走查 URL 表） |
| `config.example.json` | 配置模板——所有占位符（`REPLACE_*` / `null`）集中在此 |

## 快速开始

```bash
cd qa-batch
cp config.example.json config.json   # 填 base_url / platform_api_key / web 密码等
python run_matrix.py --config config.json --dry-run   # 先看矩阵
python run_matrix.py --config config.json             # 正式跑（并发 4）
python run_matrix.py --config config.json --only host-todo,host-plan   # 子集
```

报告输出到 `qa-batch/reports/batch-qa-<时间戳>.{json,md}`。

## 需要准备的凭据与占位

| 项 | 位置 | 说明 |
|---|---|---|
| 平台 API 密钥 | `batch.platform_api_key` | **sk_…**，管理员铸造（batch API 认证用） |
| Web 账号 | `web.username/password` | 管理员账号（session 传输 + 子会话检测） |
| 沙盒容器 id | `modes.sandbox.container_id` | **数字**，平台预建容器；`null`=跳过沙盒用例 |
| SSH 项目 id | `modes.ssh.project_id` | 向导②建的 SSH 项目 |
| 本地项目 id | `modes.local-machine.project_id` | 向导④绑你机器的项目 |
| 快速模板 | `modes.quick.enabled/template_id` | `enabled:false`=跳过 |
| MCP 工具 | `features.mcp.tool_name/server_name` | pi-mcp-adapter 已注册的工具；REPLACE=跳过 |
| 备选模型 | `models[].label/model` | 模型组合矩阵，默认 Qwen3.8-27B × off/medium/high |

## 用例与断言

| 功能 | 提示词要点 | 机械断言 |
|---|---|---|
| sanity | 读注入的 `task.txt` 原样汇报+行数字符数（host）；pwd/ls（沙盒/远程） | 任务 completed；回复非空；出现 read/bash/ls 类工具 |
| plan | 为 wordcount 任务制定计划并用 plan 工具保存，本轮不实现 | 工具日志含 `plan`；回复含"计划" |
| todo | 三项待办逐项执行勾选后汇报清单状态 | 工具日志含 `todo` |
| subagent | 启动 general-purpose 子智能体探查目录，汇报其结论 | 工具日志含 `Agent`；**会话列表存在嵌套子会话**（parentSessionId 指向父） |
| mcp | 调用指定 MCP 工具并原样汇报原始返回 | 工具日志含配置的工具名 |

失败详情（哪个断言、工具日志摘要、错误文本）都写进报告的"失败/错误详情"节。

## UI 走查（人工部分）

报告 Markdown 的表格里每个用例带 `?session=<id>` 链接。功能断言（API 层）
通过后，按报告尾部的"UI 走查清单"打开对应会话检查渲染：plan 面板、待办
勾选、**子智能体侧栏嵌套（⌘ 标记）与右面板 viewer**、MCP 工具卡片、
各模式分组徽标。

## 注意

- 程序化调用**不要**带 `Origin`/`sec-fetch-site` 头——服务端只对带这些头
  的请求做同源校验（`lib/request-security.ts`），Python 默认不带即放行。
- batch API 的模式支持以服务端为准（当前 host/sandbox；ssh 等走 session
  传输是等价覆盖，行为差异见 `app/api/batch/tasks/route.ts` 校验注释）。
- `task_timeout_s` 默认 900s；子智能体/plan 用例较慢，真实模型下单例
  40~120s 属正常。
- 报告与 config.json 含密钥/地址，**勿入库**（`.gitignore` 已配 reports/ 与
  config.json——见仓库根 .gitignore 的 qa-batch 段）。
