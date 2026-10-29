# Agent 的环境依赖：声明、打包与离线运行（方案）

> 2026-10-29。回答"Agent 依赖第三方包/工具时，内网无镜像、发布后也带不走镜
> 像源"的问题。目标读者：平台/pi-web 维护者、打包发布负责人。

## 一、问题与约束（代码事实）

| 事实 | 影响 |
|---|---|
| 默认部署带 Node（应用运行时）；Python 取决于镜像/宿主 | 不能假设目标机有任意 pip/npm 包 |
| 内网有镜像源，但**发布后的运行环境不可靠**（离线/镜像下线） | 运行时安装不可作为默认路径 |
| `.pi/extensions/<name>/node_modules` 可随配置包分发（`PI_EXTENSIONS` 与配置包导入都保留依赖树） | Node 依赖已有"随包走"的通道 |
| 沙盒模式跑平台镜像（SIF），工作区可写、镜像层只读 | 依赖要么进镜像，要么进工作区 |
| 配置包上限现由管理员配置（默认 2048MB，>200MB 二次确认） | 打包依赖的体积有现实上限 |
| `bundle.json.dependencies` 目前仅展示（字符串数组） | 缺少机器可执行的依赖契约 |

结论：**离线优先**（依赖随包/随镜像走），镜像源只作为"有就用"的加速层，
不能作为正确性前提。

## 二、分层方案

### L1 声明层：让依赖可被机器读取

`bundle.json` 的 `dependencies` 从"展示用字符串"升级为可结构化（保持字符串
兼容）：

```json
{
  "dependencies": [
    "node>=20",
    { "kind": "python", "spec": "pandas==2.2.3", "target": "cp311-manylinux" },
    { "kind": "node", "spec": "left-pad@1.3.0" },
    { "kind": "binary", "name": "rg", "spec": ">=14", "path": ".pi/vendor/bin/rg" }
  ],
  "environment": {
    "python": { "venv": ".pi/env/py", "wheels": ".pi/vendor/py" },
    "node": { "vendor": ".pi/vendor/node" }
  }
}
```

规则：字符串 = 不可细分的人读依赖（维持现状）；对象 = 构建/运行时可执行的
依赖。`environment` 声明"东西放在哪"，避免运行时猜路径。

### L2 打包层：依赖随包走（主路径）

- **Python**：构建机为**目标平台**下载 wheels（`pip download --only-binary=:all:
  --platform manylinux_2_17_x86_64 --python-version 3.11`）到
  `.pi/vendor/py/wheels/`，附 `requirements.txt` + sha256 清单。
  运行时会话首次需要时：
  `python -m venv .pi/env/py && .pi/env/py/bin/pip install --no-index
  --find-links .pi/vendor/py/wheels -r requirements.txt`。
  venv 落在**工作区**（可写、随快照/产物保留），不污染系统 Python。
- **Node**：两条路——扩展自带的 `node_modules`（现有通道）；或
  `npm pack` 的 tarball 放 `.pi/vendor/node/`，bootstrap 时
  `npm install --offline --no-audit --prefix .pi/env/node <tarball...>`。
  优先随包 node_modules（零安装步骤、离线最稳）。
- **二进制/CLI**：`.pi/vendor/bin/`（与现有 `PI_BINARIES` 同思路），启动时
  前置进 PATH；`chmod +x` 由导入器负责。
- **体积**：wheel/tarball 享受配置包上限（管理员可调）；同一包按
  `manylinux` 目标只带一份，不要多 Python 版本混带。

### L3 镜像层：沙盒模式优先烘焙

沙盒会话跑在平台镜像里。凡是"这个 Agent 的所有会话都需要"的重依赖
（CUDA、大型科学计算栈），应烘焙进镜像，而不是每次会话装：

- 平台镜像构建时 `pip install` 到镜像；`bundle.json.dependencies` 里声明
  `{ "kind": "image", "image": "swe-bench-…:v3" }` 表示"依赖镜像已满足"。
- 好处：会话零安装、磁盘不重复、离线天然成立；代价：换依赖要重建镜像。
- 混合策略：镜像放重依赖，配置包放轻依赖（wheel/tarball）。

### L4 镜像源层：有就用，没有就跳过

运行时按顺序尝试：

1. 已满足（venv 存在 / 包可导入 / 二进制在 PATH）→ 直接返回；
2. 本地 vendor（`--no-index --find-links`）；
3. 部署配置的镜像源（`PI_WEB_PIP_INDEX_URL` / `NPM_CONFIG_REGISTRY`）；
4. 全部失败 → 明确报错，提示"依赖未随包分发"（而不是静默 `pip install`
   卡住或写到系统目录）。

镜像源只影响"能否更快/更新"，不改变离线可用性。

### L5 会话层：让模型知道怎么做

- env-info 注入一段"依赖环境"事实：`python3`/`node` 版本、vendored 目录
  是否存在、venv 路径、可用命令（`pip --no-index`）。
- Agent Builder 的 agent-packaging 技能增加"依赖声明与 vendor"章节：
  生成 Agent 时，把 pip/npm 依赖写进 `bundle.json` 并落到
  `.pi/vendor/`，自检清单加一条"断网可跑"。
- 禁止：`sudo apt-get`、写系统 site-packages、假设有网。

## 三、实现顺序（建议）

| 阶段 | 内容 | 位置 |
|---|---|---|
| P1 | `bundle.json` 结构化依赖 schema（校验、兼容字符串）；bundle 导入时透传 `environment` | pi-web `lib/project-config-bundle.ts`、`bundle-inspect.ts` |
| P2 | 打包脚本：`scripts/bundle-vendor.mjs`（pip download / npm pack / 二进制拷贝 + sha256 清单） | pi-web `scripts/` |
| P3 | 会话 bootstrap：`pi-config` 新增 `env-bootstrap` 扩展（幂等：检测→本地安装→报错），env-info 注入事实 | `pi-config/agent/extensions/` |
| P4 | 镜像侧：文档化"重依赖进镜像"流程 + `dependencies.kind=image` 校验 | 平台镜像构建文档 |
| P5 | 镜像源：`PI_WEB_PIP_INDEX_URL` / `NPM_CONFIG_REGISTRY` 透传到会话 env | pi-web 会话 env 注入 |

验收（每阶段）：

- 断网环境（`unshare -n` 或防火墙拒绝）下安装并运行一个带 pandas 的
  Agent：`pip install --no-index` 成功、示例脚本跑通。
- 依赖缺失时错误信息包含包名与"未随包分发"提示，而不是超时。
- 配置包体积与磁盘：一个带 200MB 依赖的包能上传（>200MB 二次确认）、
  套用后工作区/镜像不重复膨胀。

## 四、明确不做

- 不做"运行时代装 + 镜像源回退"作为默认：离线部署会静默失败或卡住。
- 不把 secret/许可证放进 vendor 目录（配置包会分发到多台机器）。
- 不承诺在只读镜像层内 `pip install`（沙盒会话需写工作区 venv）。
