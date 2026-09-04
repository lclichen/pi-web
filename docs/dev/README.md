# docs/dev —— 平台开发与运维文档索引

> 本目录收录 amedac.ai fork 在 upstream pi-web 之上新增的开发/运维文档
> （原 `docs/` 根只保留 upstream 自带的 adr/、screenshots/、i18n.md、
> release.md、worktrees*.md、screenshot2.png）。这里是 Docs Guide 主页的
> 内容源，按下面的信息架构组织即可直接映射为文档站导航。

## 建议的 Docs Guide 信息架构

```
首页（Docs Guide）
├─ 快速开始        → DEPLOYMENT.md §1-3（下载/启动/首登）
├─ 架构            → PLATFORM.md（组件与端口、数据落位）
│    └─ 多用户与模式 → multi-user-and-modes-design.md
├─ 使用手册        → 平台功能检查手册.md（按其 §1-14 抽取为用户手册章节）
├─ 测试            → 全流程测试方案.md（L0/L1/L2、qa-e2e-tester 用法）
└─ 运维            → DEPLOYMENT.md §4+（升级、打包、AppImage、故障排查）
```

## 文档清单

| 文件 | 内容 | 受众 |
|------|------|------|
| `PLATFORM.md` | 平台总览：pi-web / 沙盒平台 / relay / apptainer 的组件关系、端口、数据目录落位 | 开发、运维 |
| `multi-user-and-modes-design.md` | 多用户隔离与四种执行模式（host/沙盒/本机/SSH）的设计决策与权限矩阵 | 开发 |
| `DEPLOYMENT.md` | 部署与运维：环境要求、启动、升级、打包（tar/AppImage）、常见故障（含 apptainer starter 255 排障） | 运维 |
| `CONNECT_LOCAL_MACHINE.md` | 「连接本地」配对协议与 relay 能力边界 | 开发、用户 |
| `平台功能检查手册.md` | 14 节端到端功能/权限走查手册（admin vs 普通用户） | 测试、验收 |
| `全流程测试方案.md` | 三层测试方案（L0 静态 / L1 本地 dev+mock / L2 VM 实机）、回归集选择、QA 子智能体接入 | 测试、开发 |

## 维护约定

- 新增平台侧文档一律进 `docs/dev/`，并在本索引登记一行。
- upstream 同步时只动 `docs/` 根的 upstream 文件；`docs/dev/` 整体视为
  fork 私有内容（合并冲突时以我方为准）。
