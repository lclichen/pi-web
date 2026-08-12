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
  方式一（推荐）: 在终端运行  ./start.sh   菜单选择
  方式二（直接）:
    ./pi              —— 终端里启动 CLI Agent，用法同官方 pi 命令
    ./pi-web.sh       —— 启动 WebUI，浏览器访问 http://127.0.0.1:30141
  桌面环境:
    双击 open-pi-terminal.sh —— 自动开一个终端窗口进入 pi
    双击 start.sh            —— 打开菜单

【让 pi / pi-web 全局可用】
  运行一次 ./install-to-path.sh
  之后在任意目录都可以直接敲 pi 或 pi-web（需要 ~/.local/bin 在 PATH 中）

【WebUI 常用参数】  （./pi-web.sh 后面跟参数，与官方 pi-web 完全一致）
    ./pi-web.sh --port 8080            自定义端口
    ./pi-web.sh --no-open              不自动打开浏览器
    PI_WEB_PASSWORD='足够长的密码' ./pi-web.sh   启用 Basic Auth（用户名 pi）

【数据与配置】
  pi 会读写 ~/.pi/ 目录（会话文件、models.json、settings.json 等），
  与官方安装共用同一份数据，互不冲突。

【配置模板（可选，取决于打包者是否打入 config/pi/）】
  本包可能自带一套 pi 配置模板（扩展、技能、提示词、主题、模型接口配置等）。
  首次运行 pi / pi-web.sh 时自动合并到 ~/.pi/agent/：
    * 扩展 / 技能 / 提示词 / 主题 / 工具：只补模板里有、你没有的文件，
      你已有的文件不会被改动；
    * models.json / settings.json：只有目标不存在时才安装。想改用打包
      版本可手动运行 ./install-pi-config.sh --force（原文件会先备份到
      ~/.pi/agent/.bundle-backup/）；
    * 会话文件与 auth.json 永远不会被改动。
  手动执行:  ./install-pi-config.sh           （幂等，无事可做时静默）
  换配置目录: PI_CODING_AGENT_DIR=/path ./pi-web.sh （与官方 pi 一致）

【检查更新】
  ./update.sh            检查更新源并更新（需要能访问更新源）
  ./update.sh --check    只检查是否有新版本
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
  config/     可选：pi 配置模板（config/pi/）与更新源地址（update-url.txt）
  pi          CLI Agent 启动器
  pi-web.sh   WebUI 启动器
  start.sh    菜单入口
  open-pi-terminal.sh   桌面双击进入 CLI
  install-to-path.sh    安装到 PATH
  install-pi-config.sh  应用 pi 配置模板（自动调用，也可手动执行）
  update.sh             检查并更新本包
  VERSION.txt 版本号

---------------------------------------------------------------------
【常见问题】
  Q: 双击没反应？
  A: 在终端里运行 ./start.sh 或 ./pi 查看报错信息。
  Q: 端口被占用？
  A: ./pi-web.sh --port 8080
  Q: 怎么卸载？
  A: 直接删除整个目录。若执行过 install-to-path.sh，再删除
     ~/.local/bin/pi 与 ~/.local/bin/pi-web 两个软链即可。
