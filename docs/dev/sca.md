# SCA（软件成分分析）扫描

> 2026-11-03 引入。检测第三方依赖中的已知漏洞；与 `pre-commit` 的密钥扫描
> 是两件事：密钥扫描查“我们提交了什么”，SCA 查“我们依赖了什么”。

## 扫什么

| 生态 | 锁文件 | 覆盖 |
| --- | --- | --- |
| npm | `package-lock.json` | pi-web 主应用、构建期依赖 |
| Go | `agent/go.sum` | 本机 relay agent |

仓库里没有 Python/容器依赖清单；以后新增 `requirements.txt` / `pyproject.toml`
/ `Dockerfile` 时，OSV-Scanner 的 `-r ./` 会自动发现常见锁文件。

## CI 工作流

`.github/workflows/sca.yml`：

- **触发**：PR、push 到 `dev` / `dev-0.85.1` / `main`、每周一 03:17 UTC、手动。
- **工具**：Google [OSV-Scanner](https://google.github.io/osv-scanner/) v2.7.0
  （复用官方 workflow，扫描后上传 SARIF 到 **Security → Code scanning**）。
- **失败语义**：
  - PR / push：只报告（`fail-on-vuln: false`），不挡合并；
  - 定时任务：`fail-on-vuln: true`，有已知漏洞时红，提醒维护者处理。
- **权限**：`contents: read`、`actions: read`、`security-events: write`（上传 SARIF）。

查看结果：GitHub 仓库 **Security → Code scanning → OSV-Scanner**。
PR 的 Files changed 里也会出现 annotation。

## 依赖更新

`.github/dependabot.yml`：

- npm：每周一，生产/开发依赖分组，最多 5 个 PR；
- `@earendil-works/*`（pi SDK）**不自动提 minor/major**：这些包按 SDK 版本
  精确钉住，升级要走一次完整的兼容性验证；
- Go agent：每周一组内更新；
- GitHub Actions：每周一组内更新。

Dependabot 的 security update 不受上面的 ignore 影响：有 CVE 时仍会提 PR。

## 本地自查

npm audit 需要 registry 支持 audit 接口；`registry.npmmirror.com` 不实现该接口，
所以本地可能返回 `[NOT_IMPLEMENTED]`。用官方 registry：

```bash
npm_config_registry=https://registry.npmjs.org npm audit --omit=dev --audit-level=high
```

OSV-Scanner（任选其一）：

```bash
# 官方发布页下载单文件二进制后：
osv-scanner scan source -r .
# 或只扫 npm 锁文件：
osv-scanner --lockfile=package-lock.json
```

Go 侧可额外用调用图分析（比 go.sum 匹配更准，需要联网拉漏洞库）：

```bash
cd agent && go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

## 处置流程

1. **有修复版本**：升级依赖；pi SDK 相关的升级走单独的兼容性提交（见
   [upstream-0.14-gap-and-ui-review.md](./upstream-0.14-gap-and-ui-review.md)）。
2. **无修复版本 / 不可达**：在仓库根建 `osv-scanner.toml` 记录接受风险，
   必须带原因和复查日期：

   ```toml
   [[IgnoredVulns]]
   id = "GHSA-xxxx-xxxx-xxxx"
   ignoreUntil = 2027-01-31
   reason = "仅构建期使用，不进入发布产物；等待上游修复"
   ```

   OSV-Scanner 的扫描参数里加 `--config=osv-scanner.toml`（CI 里在
   `scan-args` 追加即可）。
3. **误报**：同样走 `IgnoredVulns`，写清证据。

## 注意

- SCA 只覆盖**已知 CVE**，不替代代码审计、path-guard、项目 trust 或密钥扫描。
- npm 的 devDependencies 也会被扫描；如果某个漏洞只在本地工具链可达，
  在 `IgnoredVulns` 里说明，而不是关闭整个扫描。
- 定时任务红了不等于发布必须停：先看 `Code scanning` 的路径和可达性，
  再决定修复/接受风险。
