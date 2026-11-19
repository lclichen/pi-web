# .apkg 本地开发测试：手动指定私钥

正式发布包会把接收方私钥 `seal` 进客户运行版二进制；本地 dev 不必每次封装，
可以用 `PI_WEB_APKG_IDENTITY` 直接指定一个私钥 JSON。该变量**仅用于开发/测试**，
发布脚本和 `start-all.sh` 都不会设置它。

## 1. 准备身份与解密组件

```bash
# 生成一个开发身份（私钥 dev-identity.json 只在开发机）
apkg-publisher identity new \
  --out dev/dev-identity.json \
  --public-out dev/dev-recipient.json
```

解密组件可以是完整版或运行版，不要求已封装；放到以下任一位置：

- `pi-web-0851/bin/apkg-publisher`（或 Windows `apkg-publisher.exe`）
- `<数据目录>/bin/apkg-publisher`
- PATH
- 或显式设置 `PI_WEB_APKG_TOOL=<绝对路径>`

## 2. 启动 dev WebUI

PowerShell：

```powershell
$env:PI_WEB_APKG_IDENTITY = "D:\path\to\dev-identity.json"
# 组件不在 bin/ 时再设置：
# $env:PI_WEB_APKG_TOOL = "D:\path\to\apkg-publisher-runtime.exe"
npm run dev
```

bash：

```bash
PI_WEB_APKG_IDENTITY=/path/to/dev-identity.json \
PI_WEB_APKG_TOOL=/path/to/apkg-publisher-runtime \
npm run dev
```

环境变量在进程启动时读取；修改后需重启 dev。

## 3. 验证

- 管理页「加密身份」应显示 **开发身份（私钥 JSON）**，并展示 id/公钥；页面
  只回显公钥，私钥不会通过 API 返回。
- 用同一开发身份的公钥打包：

  ```bash
  apkg-publisher pack --in demo.zip --recipient dev/dev-recipient.json --out demo.apkg
  ```

- 在 WebUI 中上传 `.apkg` 到项目配置导入 / 配置模板套用，能成功解密并写入
  文件即表示链路正常；导出应被 403 拒绝（bundle lock）。
- 想直接验证 CLI 解密：

  ```bash
  apkg-publisher open --in demo.apkg --identity dev/dev-identity.json --out -
  ```

## 4. 与正式发布的区别

| | 本地 dev | 正式发布 |
|---|---|---|
| 私钥位置 | `dev-identity.json`（开发机） | 打包时 `seal` 进客户运行版二进制 |
| 解密参数 | `open --identity <json>` | `open`（读取自身封条） |
| 环境变量 | `PI_WEB_APKG_IDENTITY` | 不设置 |
| WebUI 标记 | 开发身份（私钥 JSON） | 发布包（公钥文件） |

不要把 `PI_WEB_APKG_IDENTITY` 带进生产部署；生产环境即使设置了它，也只是
回退到明文私钥路径，会削弱封装的意义。
