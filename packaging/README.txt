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

【离线限制：以下功能需要联网】
  * 模型 API 请求本身（聊天 / 推理）
  * 技能搜索与安装（内部调用 npx skills ...）
  * OAuth 登录、模型发现与测试、models.dev 目录
  其余功能（会话读写、聊天界面、文件预览、Git Worktree 等）完全离线可用。

【目录结构】
  app/        pi-web 应用本体（bin / .next / public / node_modules）
  runtime/    内置 Node.js 运行时
  pi          CLI Agent 启动器
  pi-web.sh   WebUI 启动器
  start.sh    菜单入口
  open-pi-terminal.sh   桌面双击进入 CLI
  install-to-path.sh    安装到 PATH
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
