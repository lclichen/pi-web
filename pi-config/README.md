# pi-config —— 随离线包分发的 pi 配置模板

这个目录的内容会随 `scripts/package-linux.sh` 构建的离线包一起打包成包内
的 `config/pi/`，目标机器**首次运行**时自动合并到 `~/.pi/agent/`，用于
规范分发 pi 的扩展、技能、主题、提示词与模型接口配置。

## 目录结构

把要分发的东西按 `~/.pi/agent/` 的布局放到 `agent/` 下：

```
pi-config/
├─ README.md            # 本说明（不会打进包）
└─ agent/               # 内容 = ~/.pi/agent 的模板
   ├─ extensions/       # pi 扩展（.ts/.js）
   ├─ skills/           # 技能（SKILL.md）
   ├─ prompts/          # 提示词模板
   ├─ themes/           # 主题
   ├─ tools/            # 自定义工具
   ├─ models.json       # 模型接口配置（可用 WebUI 的 ModelsConfig 生成后拷入）
   └─ settings.json     # 设置（默认模型等）
```

## 打包规则

- 打包时排除：`sessions/`（会话）、`auth.json`（凭证）、`bin/`（托管
  二进制）、`tmp/`、调试日志 —— 这些是用户数据，永远不会被打包或覆盖。
- 安装合并规则（`packaging/install-pi-config.sh`，幂等）：
  - 目录类资源（extensions/skills/prompts/themes/tools）只补缺失文件，
    不覆盖用户已有的文件；
  - `models.json` / `settings.json` 目标不存在才安装；目标机可用
    `./install-pi-config.sh --force` 覆盖（原文件先备份）；
  - 会话与 `auth.json` 永不被改动。
- 版本：打包时用 `PI_CONFIG_VERSION` 指定模板版本（默认 1）。发布新版
  包时递增它，目标机下次启动会自动应用配置增量。已应用版本记录在
  `~/.pi/agent/.bundle-version`。

## 本地构建

```bash
# 用仓库里这份模板（默认行为）
bash scripts/package-linux.sh

# 或指定你自己的 .pi 目录（~/.pi 或 ~/.pi/agent 均可，自动识别）
PI_CONFIG_DIR=~/.pi bash scripts/package-linux.sh
```

CI（`.github/workflows/package-linux.yml`）也会自动打包本目录。
