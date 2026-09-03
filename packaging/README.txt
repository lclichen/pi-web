=====================================================================
  pi + pi-web  Linux 离线分发包
=====================================================================

【这是什么】
  本目录包含 pi 编程智能体的完整离线运行环境，无需安装 Node.js、
  无需联网即可使用：
    * pi-web   —— pi 的本地网页界面（在浏览器里用）
    * pi       —— pi 的终端 CLI Agent（TUI）
    * runtime/ —— 内置的 Node.js 运行时

【快速开始】
  本包若含沙盒教学平台组件（存在 sandbox/ 目录）:
    ./scripts/start-all.sh   —— 一键启动 沙盒平台 + WebUI（首次运行自动生成配置）
    ./scripts/status-all.sh  —— 服务状态与日志位置
    ./scripts/stop-all.sh    —— 停止全部
    浏览器访问 http://<本机IP>:30141 ，默认账号 admin/changeme123（登录后请改密）。
    创建沙箱容器需要目标机已安装 Apptainer（https://apptainer.org）。

  纯 pi / pi-web（无沙盒组件）:
    方式一（推荐）: 在终端运行  ./scripts/start.sh   菜单选择
    方式二（直接）:
      ./pi              —— 终端里启动 CLI Agent，用法同官方 pi 命令
      ./pi-web.sh       —— 启动 WebUI，浏览器访问 http://127.0.0.1:30141
    桌面环境:
      双击 scripts/open-pi-terminal.sh —— 自动开一个终端窗口进入 pi
      双击 scripts/start.sh            —— 打开菜单

【让 pi / pi-web 全局可用】
  运行一次 ./scripts/install-to-path.sh
  之后在任意目录都可以直接敲 pi 或 pi-web（需要 ~/.local/bin 在 PATH 中）

【WebUI 常用参数】  （./pi-web.sh 后面跟参数，与官方 pi-web 完全一致）
    ./pi-web.sh --port 8080            自定义端口
    ./pi-web.sh --no-open              不自动打开浏览器
    PI_WEB_PASSWORD='足够长的密码' ./pi-web.sh   启用 Basic Auth（用户名 pi）

【数据与配置】
  pi 会读写 ~/.pi/ 目录（会话文件、models.json、settings.json 等），
  与官方安装共用同一份数据，互不冲突。

【配置模板（可选，取决于打包者是否打入 config/pi/）】
  本包可能自带一套 pi 配置模板（扩展、技能、提示词、主题，模型接口配置，
  以及已装好的插件等）。首次运行 pi / pi-web.sh（或 AppImage）时自动合并
  到 ~/.pi/agent/：
    * 扩展 / 技能 / 提示词 / 主题 / 工具：只补模板里有、你没有的
      文件，你已有的文件不会被改动；
    * npm/（插件与依赖整树）与 extensions/ 下随包的本地扩展包目录
      （带各自 node_modules，pi 自动发现加载）：默认以**软链**接入包内
      config/pi/（零拷贝，启动无拷贝耗时，只读内容不落到包外；
      CLI/WebUI 共享同一份包内内容；包目录就地升级时内容自动跟随）。
      注意：软链依赖包目录存续——若计划删除/移动包目录后仍要使用
      配置，先以 AMEDAC_PKG_MODE=copy 运行一次，改为真实目录整体拷
      贝（一次性拷贝，之后幂等，与包位置完全独立）；
    * 随包扩展是"受管内容"：软链模式下为软链引用，拷贝模式下为受管
      拷贝（目录内有版本标记）。换新包、模板版本升级时自动重指/重建
      到新版，新版包中不再包含的旧扩展目录自动删除。要自行修改这些
      扩展，请先复制一份到新目录名（受管目录内的本地改动不保留）；
    * 旧版本（v2 及以前）或模式切换留下的指向旧包路径/挂载目录的软
      链（悬空或仍存活）自动识别：软链模式下重指当前包，拷贝模式下
      以真实拷贝接管。用户自建、指向包外的软链保留不动；
    * models.json：只有目标不存在时才安装。想改用打包版本可手动运行
      ./scripts/install-pi-config.sh --force（原文件会先备份到
      ~/.pi/agent/.bundle-backup/）；
    * settings.json：做字段级合并 —— 只把模板里的插件来源（packages）
      合并进来，你已配置的其他项（默认模型等）不会被改动或重置；
    * 会话文件与 auth.json 永远不会被改动。
    * AppImage 形态（另一种分发包）：同为默认软链模式——链接指向
      AppImage 挂载点内的内容（零拷贝，只读内容不落到容器外）。挂载
      点随进程消失，故 --web 以前台监护方式运行，服务与 AppImage 同
      生命周期（AppImage 关闭即停，不会留下悬空链接）。
  手动执行:  ./scripts/install-pi-config.sh   （幂等，无事可做时静默）
  换配置目录: PI_CODING_AGENT_DIR=/path ./pi-web.sh （与官方 pi 一致）

【检查更新】
  ./scripts/update.sh            检查更新源并更新（需要能访问更新源）
  ./scripts/update.sh --check    只检查是否有新版本
  更新只替换程序本体，下载包会做 SHA256 校验；你的会话与配置在
  ~/.pi/，位于包外，不受更新影响。更新源默认取 app/package.json 里的
  仓库地址（GitHub Releases 的 latest/download），内网分发请在打包时
  用 PI_UPDATE_BASE_URL 指定托管 versions.json 的目录。

【离线限制：以下功能需要联网】
  * 模型 API 请求本身（聊天 / 推理）
  * 技能搜索与安装（内部调用 npx skills ...）
  * OAuth 登录、模型发现与测试、models.dev 目录
  其余功能（会话读写、聊天界面、文件预览、Git Worktree 等）完全离线可用。

【目录结构】
  app/        pi-web 应用本体（bin / .next / public / node_modules）
  runtime/    内置 Node.js 运行时
  bin/        可选：附带 CLI 工具（fd / rg 等，启动时自动加入 PATH）
  config/     可选：pi 配置模板（config/pi/）与更新源地址（update-url.txt）
  pi          CLI Agent 启动器
  pi-web.sh   WebUI 启动器
  scripts/    辅助脚本与文档（见下）
    start.sh                 菜单入口
    open-pi-terminal.sh      桌面双击进入 CLI
    install-to-path.sh       安装到 PATH（软链到 ~/.local/bin；启动器会自行
                             解析软链指向的真实包目录，安装后不受目录移动影响）
    install-pi-config.sh     应用 pi 配置模板（自动调用，也可手动执行）
    update.sh                检查并更新本包
    README.txt               本说明
    VERSION.txt              版本号

---------------------------------------------------------------------
【常见问题】
  Q: 双击没反应？
  A: 在终端里运行 ./scripts/start.sh 或 ./pi 查看报错信息。
  Q: 端口被占用？
  A: ./pi-web.sh --port 8080
  Q: 怎么卸载？
  A: 直接删除整个目录。若执行过 install-to-path.sh，再删除
     ~/.local/bin/pi 与 ~/.local/bin/pi-web 两个软链即可。
     注意：~/.pi/agent/ 里的 npm/ 与随包扩展默认是指向包目录的软链，
     删除包目录后它们会悬空（不影响其它功能，再次运行任一入口会自动
     清理）；若想在删包后仍保留这些内容，删包前先以 AMEDAC_PKG_MODE=copy
     运行一次转为真实拷贝。
