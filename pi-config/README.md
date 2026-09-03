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
  - `npm/` 与随包扩展包（自带 node_modules）**默认走软链模式**（两种
    部署形态相同，零拷贝、内容不落到包外）：tar.gz 部署由启动器设置
    `PI_CONFIG_LINK_ROOT` 指向包根，包目录持久、链接长期有效，CLI/WebUI
    共享同一份包内内容；AppImage 部署由 AppRun 设置 `PI_CONFIG_LINK_ROOT`
    指向挂载点，内容不落到容器外，链接每次启动无条件刷新，`--web` 以前台
    监护运行、服务随 AppImage 退出而停止。需要安装独立于包目录存续时，
    设 `AMEDAC_PKG_MODE=copy` 切换为**真实目录整体拷贝**（离线、与包位置
    无关，首次拷一次、之后按标记幂等跳过）；
  - 随包扩展是"受管内容"，模板版本升级时自动重指/重建到新版、新版包中
    不再包含的旧目录自动删除（拷贝模式带版本标记
    `.pi-web-bundle-version`）——要自行修改这些扩展，请先复制一份到
    新目录名（受管目录内的本地改动不保留）；
  - 存量软链（含旧版本 v2 及以前残留、指向包内 `config/pi/` 的失效/存活
    链接）自动识别：软链模式下重指当前包，拷贝模式下以真实拷贝接管；
    用户自建、指向包外的软链保留不动；
  - `models.json` / `settings.json` 目标不存在才安装；目标机可用
    `./install-pi-config.sh --force` 覆盖（原文件先备份）；
  - 会话与 `auth.json` 永不被改动。
- 版本：打包时用 `PI_CONFIG_VERSION` 指定模板版本（当前 3）。发布新版
  包时递增它，目标机下次启动会自动应用配置增量（v3 递增用于触发存量
  机器清理旧版残留软链并重新合并）。已应用版本记录在
  `~/.pi/agent/.bundle-version`。

## 本地构建

```bash
# 用仓库里这份模板（默认行为）
bash scripts/package-linux.sh

# 或指定你自己的 .pi 目录（~/.pi 或 ~/.pi/agent 均可，自动识别）
PI_CONFIG_DIR=~/.pi bash scripts/package-linux.sh
```

CI（`.github/workflows/package-linux.yml`）也会自动打包本目录。
