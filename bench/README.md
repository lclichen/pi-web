# pi-web harness bench — 框架+模型整体能力基准（P0-2）

一套用来回答"**框架切片和模型切片各贡献了多少失败**"的基准设施。它驱动**真实的 pi AgentSession**
（与 `lib/rpc-manager.ts` 产品会话相同的 SDK 入口），注入**产品会话相同的内联扩展栈**
（todo + session-plan），在隔离的临时工作区里跑任务，用**确定性判分器**（不给 judge 模型打分）
判定结果——判分语义移植自 pi-lab-training 的 VerifyEngine，外加会话转录层面的行为判分。

## 两层纪律（沿用 pi 上游 evals 的边界约定）

| 层 | 触发方式 | 是否碰网络 | 覆盖什么 |
|---|---|---|---|
| **CI 层** `bench/bench.test.mjs` | `npm test`（已进默认套件） | ❌ 永不 | 任务 fixture 合法性、判分器正确性、报告渲染、模型门禁、扩展栈注册 |
| **真模型层** `bench/runner.mjs` | `npm run bench -- --provider P --model M` | ✅ 真实 API | 任务完成度 + todo/plan 工具行为指标 |

runner 在没有 `--provider/--model`（或 `PI_PROVIDER`/`PI_MODEL`）时**直接拒绝启动**，
保证 CI 永远不会误触付费 API。

## 使用

```bash
# 单模型全量
npm run bench -- --provider zai --model glm-4.7

# 只跑某个能力域 / 单个任务
npm run bench -- --task area:todo
npm run bench -- --task edit-fix-average

# 保留工作区与会话 JSONL 以便排查（默认即写 report）
npm run bench -- --provider zai --model glm-4.7 --keep
```

模型认证走 pi 的常规通道（`~/.pi/agent/auth.json` / OAuth / API key 环境变量 /
`models.json` 自定义 provider），见 `pi/packages/coding-agent/docs/models.md`。

产物：

- `bench-results/<时间戳>/report.md` —— 人读报告：总分、**分域能力表**（失败按
  edit/bash/todo/plan/refactor/verify 定位到模块）、todo 行为指标、失败明细。
- `bench-results/runs.jsonl` —— 每任务一行，跨 run 追加，供趋势对比（约定同
  pi-smart-compact 的 telemetry-report）。

## 任务集（bench/tasks.ts）

| Task | Area | 考察点 |
|---|---|---|
| `edit-fix-average` | edit | 定位→修复→跑测试（不许削弱测试） |
| `bash-sorted-artifact` | bash | shell 管道产出文件（sort -u） |
| `todo-multi-step-discipline` | todo | **P0-1 的活体易用性套件**：建单、单一 in_progress、逐步完成、无校验错误 |
| `plan-save-and-implement` | plan | plan_save 先行 + checkbox 步骤 + 按计划实施 |
| `refactor-rename-across-files` | refactor | 跨文件重命名不残留引用 |
| `verify-faithful-report` | verify | 修根因 + 如实汇报（REPORT.md 最后一行必须与真实退出码一致） |

加任务 = 在 `tasks.ts` 加一个条目（fixture 文件 + prompt + checks），fixture 校验在 CI 层自动执行。

## 判分器（bench/checks.ts）

- **文件类**：`file_exists` / `file_not_exists` / `file_contains`（text|regex）/ `file_not_contains`
- **执行类**：`node_script`（跨平台首选）、`command`（argv 数组直跑，无 shell）
- **行为类**（转录判分，定位框架/提示词缺陷的关键）：
  - `plan_saved` —— `.pi/plans/` 下存在含 `- [ ]` 步骤的计划文件
  - `todo_used` —— 调用次数上下界 + `forbidErrors`（todo 校验错误 ≈ 模型没理解工具契约
    或 schema/引导有问题）
  - `todo_all_completed` —— 最终快照全 completed 或触发自动清空

## 结果怎么读（定位不足）

1. **某 area 全模型一致挂** → 框架/扩展缺陷（比如 todo area 挂 → 查 todo 工具 schema、
   promptGuidelines、widget 链路）。
2. **某模型某 area 独挂** → 模型能力短板。
3. **todo error calls 高** → 工具不易用（P0-1 的直接观测指标），优先调整参数 schema
   描述与 promptGuidelines，再用 `--task area:todo` 回归。
4. **no-op calls 高** → 模型重复重发，检查提示词是否诱导复述。
5. runs.jsonl 跨 run 对比 tokens/calls/pass 率，量化"针对性优化"的收益。

## 与 pi/packages/evals 的关系

上游 `pi/packages/evals`（vitest-evals）是本设施的设计参照：隔离工作区、多步 prompt、
session 快照、usage 采集都沿用其 harness 模式。此处不复用而另建的原因：
需要注入 **pi-web 产品专属的扩展栈**（todo/session-plan）、需要**确定性判分**而非 judge
模型、需要**分域能力归因**报告；且 `pi/` 目录定位是上游克隆（开发参照），不应承载本仓库的测试资产。
