# VM 工具（scripts/vm/）

VM 测试环境 = `10.99.9.7`（SSH 凭据走 `scripts/vm-credentials.cjs`，gitignored，或
`VM_HOST/VM_USER/VM_PASSWORD` 环境变量）。pi-web 跑 `~/amedac/pi-web`（30141），
沙盒平台（3000），relay（30142）。

## 统一入口

```bash
node scripts/vm/vm.cjs status                 # 端口/进程/PI_WEB_* 环境/磁盘一览
node scripts/vm/vm.cjs probe '<shell>'        # 一次性 shell（通用逃生门）
node scripts/vm/vm.cjs build                  # npm run build（失败自动打日志尾）
node scripts/vm/vm.cjs restart                # 重启 pi-web（自动继承现网 PI_WEB_* 环境）
node scripts/vm/vm.cjs deploy [--branch dev]  # git 部署：fetch+reset → build → restart → 冒烟
node scripts/vm/vm.cjs hot-sync <file...>     # 未提交文件热同步 + build + restart（逃生门⚠）
node scripts/vm/vm.cjs logs [N]               # tail piweb.log
node scripts/vm/vm.cjs npm-install            # 恢复 devDeps（打包脚本跑过之后必须）
node scripts/vm/vm.cjs test <auth|todo|pkg-layout|firstrun>
```

## 两条同步路线（约定）

| 路线 | 命令 | 何时用 |
|---|---|---|
| **git 部署（主流程）** | `deploy` | **只部署已推送到 origin/dev 的提交**。日常发布一律走这条：commit → push（走代理 `-c http.proxy=…`）→ deploy。 |
| 热同步（逃生门） | `hot-sync` | 临时验证**未提交**的改动（如本次 v1.3 冒烟）。用后二选一：提交走 deploy 转正；`git checkout -- <file>` 恢复 VM 树。**不要长期滞留**，否则 VM 树与 git 历史漂移，下次 deploy reset 会静默丢掉这些改动。 |

deploy 的 `git reset --hard origin/dev` 会**覆盖**热同步过的文件——这是特性（回到
git 事实源），也是用后必须转正的原因。

## 环境事实（踩过的坑，执行前自查）

- **磁盘 ~19G 常年 85-95%**：构建约需 1G+，完整打包周期约需 4G 空闲。清理配方：
  `rm -rf build .next dist` + `npm cache clean --force`（2026-09-23 实测回收 ~3.7G）。
- **非交互 SSH 无 node PATH**：脚本内一律 `export PATH=/home/llmx/tools/node/bin:$PATH`。
- **package-linux.sh 跑过之后 node_modules 丢 devDeps**（typescript 没了 →
  `@/lib/*` Module not found）：先 `vm.cjs npm-install` 再 build。
- **ssh 通道里 `setsid nohup …&` 可能挂住通道**：统一 `timeout NNN bash -s` + 落盘日志再 cat。
- 杀服务：`ss -tlnp | grep :30141` 取 pid；`pkill` 要写 `next[-]server` 防自匹配。
- 重启会自动从 `/proc/<pid>/environ` 继承 `PI_WEB_*`/`AMEDAC_*`（不会丢平台
  URL / 沙盒扩展路径 / 数据目录配置）。

## 旧脚本对照（保留兼容，逐步迁移到统一入口）

| 旧脚本 | 对应命令 |
|---|---|
| `vm-deploy-0909.cjs` | `vm.cjs deploy`（旧脚本固定 dev 分支；新入口支持 --branch） |
| `vm-npm-install.cjs` | `vm.cjs npm-install` |
| `vm-auth-test3.cjs` / `vm-todo-test.cjs` / `vm-pkg-layout-test.cjs` / `vm-firstrun-verify.cjs` | `vm.cjs test <auth|todo|pkg-layout|firstrun>` |
| `vm-connection.cjs` / `vm-credentials(.example).cjs` | 保留原位（凭据文件勿动），`vm/lib.cjs` 复用同一套 |
| `vm-build-pkg.cjs` / `vm-build-electron.cjs` | 打包流程专用，暂不迁移（与部署/测试正交） |
| ~~`vm-probe.cjs` / `vm-sync-v13.cjs`~~（一次性） | `vm.cjs probe` / `vm.cjs hot-sync`（已删除） |
