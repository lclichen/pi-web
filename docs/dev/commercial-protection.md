# 商业化保护方案（项目本体 + 配置包）

> 状态：**§一 配置包加密 P0 已实施**（2026-09-24，见文末"实施状态"）；其余分期待实施。
> 目标读者：需要对外商业化分发的部署/开发。
> 威胁模型先说清楚：**所有客户端/本地保护都只能提高门槛，不能做到绝对**——
> 攻击者拥有目标机 root 权限时，任何本地校验都可被绕过。方案按「防普通用户
> 误扩散 / 防低成本转卖」设计，关键秘密全部收敛在发布方与服务端。

## 一、配置包加密（加密导出 / 导入 / 禁止再导出）

### 格式：`.apkg`（加密配置包）

在现有 zip 明文包外做信封加密（v2：每包随机内容密钥加密 zip，内容密钥用
「发布方临时密钥 × 接收方公钥」派生的包装密钥保护；明文头部仅含展示元信息
与接收方指纹，**不列出包内文件**；导入侧按指纹计数）。**不再有共享 KEK /
`apkg-keys.json`，v1 包不再兼容。**

> **格式细节（字节布局、密码学参数、打包流程）已移至内部项目** `apkg-publisher`（私有）。
> **解密实现也已外置**：公开仓不含任何信封加解密代码，导入时经子进程调用
> 内部二进制（见"导入侧"第 5 条）；请勿在此补充可指导解密的配方描述。

### 导入侧（pi-web）

1. `POST /api/bundles`（与 config-import）识别 `.apkg`：调用解密组件得到明文
   zip（仅在内存中）→ 走现有导入流程（凭证剥离等不变）。
2. 导入成功后在项目 home 写 `.pi/.bundle-lock.json`：
   ```json
   { "apkg": true, "recipient": "r_…", "fingerprint": "sha256(包)", "importedAt": … }
   ```
3. **禁止再导出**：`/api/projects/:id/config-export` 与 Host 目录导出检测到
   `.bundle-lock.json` 即 403（响应明确提示「加密配置包不允许再导出」）。
   发布方内部流转用服务端命令行工具解除（不走 Web API）。
4. 同理 `/api/bundles` 的「预置模板」若由加密包上传，落盘保存密文原件，
   每次套用时经解密组件解密，不落明文 zip。
5. **解密组件外置**：`lib/apkg-open.ts` 以子进程调用 `apkg-publisher open
   --in <pkg> --out -`（纯解密预言机——密文进、明文 zip 从 stdout 出，pi-web
   不写明文临时文件）。头部解析、指纹（sha256）、许可校验、锁全部留在 pi-web
   进程内。组件查找顺序：`PI_WEB_APKG_TOOL`（显式指定，坏路径报错不回退）→
   `<cwd>/bin/apkg-publisher`（随包分发）→ `<数据目录>/bin/apkg-publisher`
   （升级不丢）→ PATH。无组件的部署仅 `.apkg` 导入报"未配备解密组件"，其余
   功能不受影响。
6. **接收方身份**：私钥在打包时由 `apkg-publisher seal` 封进**客户运行版**二进制
   （AES-GCM 封条；密钥由原二进制 sha256 + salt 派生），运行时只在内存解密，
   **发布包内不再有明文 `apkg-identity.json`，pi-web 进程也拿不到私钥**。客户
   运行版只编译 `open` / `identity show`，WebUI、文档、硬化与打包代码都不进入
   发布包（完整版只在打包机执行 seal）。pi-web 只读取公钥元信息
   `config/apkg-recipient.json`（解析顺序 `PI_WEB_APKG_RECIPIENT` →
   `<数据目录>/apkg-recipient.json` → 包内 config）；管理面
   `/api/admin/apkg-identity` 只回显 id/公钥/来源；旧
   `/api/admin/apkg-keys` 全部返回 410。

### 密钥管理

- **一客户一身份**：发布方为每个客户生成一份 X25519 身份
  （`apkg-publisher identity new`）。该客户的私钥在打包时用 `apkg-publisher
  seal` 封进客户专用解密二进制，公钥交给发布方加密。不要把同一身份复用到
  多个客户——任一客户泄露会影响所有共用该身份的包。
- 每个 `.apkg` 使用随机内容密钥；发布方每次打包生成临时密钥对完成包装，
  没有长期共享密钥可供「手填 KEK」。
- 升级 pi-web 发布包时用同一客户身份重新 seal；身份 JSON 只保存在发布方
  内部密钥库，不随包分发；丢失则需为该客户重新发布所有 `.apkg`。
- **边界**：封条提高的是提取成本，不是密码学边界。客户拥有解密二进制，
  仍可把它当解密器使用，root 也可通过逆向/内存转储提取私钥。本方案保护的是
  「只拿到 .apkg 文件或数据目录副本的人」，不是「拿到服务器的人」。要挡客户
  本人，必须改为在线授权/一次性密钥，而不是本地封装。
- **运行时解密**：封条只在 `open` 进程内存中解开，pi-web 和磁盘上都没有明文
  私钥；但这不等于“客户无法解密”——解密能力仍在那台机器上。

### 诚实边界

导入后的明文必然存在于项目 home（pi 运行时需要读）。有服务器/主机访问权的人
可以直接打包文件系统。`.bundle-lock` 防的是**经由产品自身导出功能**的二次
分发与普通用户的随手转发；配合水印（manifest 写入购买方标识）可做泄露溯源。

## 二、项目本体保护

1. **关键逻辑服务端化**：加密/授权/更新校验全部在 BFF（Node 服务端）执行，
   前端 bundle 零密钥零算法（现状已如此，保持）。
2. **更新源签名**：catalog.json 增加 `signature`（ed25519，对
   `versions[].checksum_sha256` 串联串签名）；applier 校验签名公钥（随包内置）
   后才执行交换——防止更新源本身被篡改投放恶意包。现有 sha256 只防传输损坏，
   不防恶意源；签名补齐这一层（实现小：node:crypto ed25519 一验一签）。
3. **完整性自检（可选）**：打包时生成 `integrity.json`（关键文件 sha256 清单，
   KEK 派生 HMAC），启动时抽检 + 自更新后全检；不匹配则降级为只读模式并告警。
   防止离线篡改二进制。Electron 形态可加 `bytenode`（V8 字节码）提高 main.js
   逆向成本。
4. **许可证校验（License）**：
   - 离线签名 JWT（ed25519）：payload 含 客户ID/产品/版本/过期/可选机器指纹；
     公钥内嵌，任何环境可验签；私钥只在发布方。
   - pi-web 启动读取 license 文件（部署时放置），过期/无效 → Web 挂维护页；
     宽限期 14 天应对纯内网时钟漂移。
   - 机器指纹（可选 P2）：mac 地址/CPU 序列哈希 + 发布时一次性 challenge。
5. **法律层**：分发 LICENSE 从开源条款改为商用授权条款（禁止逆向/再分发/
   去除保护），配合技术措施才有完整约束力。
6. **混淆**：Next.js 产物本身已压缩；对 `lib/` 内授权相关模块可加
   javascript-obfuscator（控制流扁平化）作为低成本附加层。

## 三、分期落地

| 期 | 内容 | 工作量估计 |
|---|---|---|
| P0 | .apkg 加密导出/导入 + bundle-lock 禁再导出 + 导入水印 | 2–3 天 |
| P0 | ed25519 离线 License 验证 + 维护页 | 1 天 |
| P1 | catalog.json 签名 + applier 验签 | 0.5 天 |
| P2 | 完整性自检 integrity.json + 机器绑定 + bytenode | 2 天 |

## 三b、WebUI 本体的保护（补充）

WebUI 是 Next.js 服务端渲染 + 客户端 bundle——**所有秘密本来就不该在前端**，
这一点现有架构天然满足（模型凭证、平台 API key、JWT 全在服务端）。保护分四层：

### 1. 运行许可（谁能跑起来）——最有效的一层

- **License JWT（离线验签）**：发布方用 ed25519 私钥签发 `{客户, 产品, 版本,
  过期, 可选机器指纹}`；pi-web 服务端内置公钥，启动与每日校验。无效/过期 →
  全站替换为维护页（中间件层重定向，不动业务代码）。
- 许可文件放 `AMEDAC_HOME/config/license.jwt`，重装/升级不丢；宽限期 14 天
  处理纯内网时钟漂移。
- 这是商业化主闸门：**拿走代码也跑不起来**，比混淆代码有效得多。

### 2. 代码保护（看不懂/改不动）

- 服务端 `.next/server` 产物本身已编译压缩；关键授权/加密模块（license 校验、
  apkg 解密）再叠加 javascript-obfuscator（控制流扁平化 + 字符串数组）。
- Next.js 客户端 bundle 可开启生产级混淆（swc minify 已有 + 可选
  scramble），并**确保这些模块的逻辑不出现在客户端**——前端只调
  `/api/license/status` 拿布尔值。
- Electron 形态：main.js 用 bytenode 编译成 V8 字节码（`.jsc`），源码不落盘。

### 3. 完整性（改了会暴露）

- 打包时生成 `integrity.json`（关键服务端文件 sha256 清单，用 License 私钥
  签名）；启动时自检，不匹配 → 拒绝启动并提示联系供应商。防破解者直接
  patch 掉 license 校验逻辑。
- 自更新链已有 sha256；叠加 catalog 签名后，更新通道也无法投毒。

### 4. 传输与接口（防白嫖调用）

- WebUI 已有多用户会话 + 平台 API key 池——商用部署保持 `PI_WEB_AUTH=on`，
  外网暴露必须走反代 + TLS（README 已述）。
- 管理类接口（bundles/quick-templates/feedback apply）已有 admin 门——
  License 层是它们之外的独立闸门，即使 admin 账号泄露，过期许可同样锁站。

### 优先级

License 验签（1 天）> integrity 自检（1 天）> 混淆（半天）> bytenode（仅
Electron 需要）。**先上 License**：它是唯一能把「复制整个部署目录给别人用」
变成不可行的措施。

## 四、明确不做（性价比过低）

- 前端 DRM/防截屏——产品内容本就要展示给最终用户。
- 对拥有 root 的目标机做强对抗（VM 探测/反调试军备竞赛）——成本高且伤正常用户。

## 五、§一 实施状态与使用指南（v2 sealed：2026-11-19）

### 已落地

| 能力 | 位置 |
|---|---|
| `.apkg` v2 信封（X25519 + HKDF-SHA256 + AES-256-GCM；header 作 AAD；明文头部仅展示元信息/接收方指纹，不含文件清单） | 内部项目 `apkg-publisher`（**公开仓无加解密实现**；`lib/apkg.ts` 仅保留明文展示头解析+策略层，`lib/apkg-open.ts` 负责子进程桥接） |
| 接收方身份（一客户一 X25519 身份；私钥打包时 `seal` 进客户专用二进制，运行时内存解密；随包只带公钥 `config/apkg-recipient.json`） | 内部项目 `apkg-publisher` + `lib/apkg.ts` + `app/api/admin/apkg-identity/route.ts` + `scripts/package-linux.sh` |
| 导入链路全量接入（项目导入 / Host 导入 / 预置模板套用自动识别 `.apkg`；**授权（过期/导入上限）在写盘前强制**） | `lib/project-config-bundle.ts` |
| 内存解密（`open --out -` 明文 zip 从 stdout 返回，不写明文临时文件；旧 `/api/admin/apkg-keys` 返回 410） | `lib/apkg-open.ts` |
| 导入计数器（`<数据目录>/apkg-imports.json`，按包指纹；**单服务器口径**，见诚实边界） | `lib/apkg.ts` |
| `.bundle-lock.json` 禁再导出（项目与 Host 两条导出路由 403；锁文件列入双向 DENIED 清单，明文包无法携带/覆盖锁） | `lib/apkg.ts` + 两个导出路由 |
| 预置模板密文存储（`.apkg` 原件落盘，套用时经外部解密组件解密；列表展示 加密·版本 徽标） | `lib/config-bundles-store.ts` + `BundlesConfig.tsx` |
| manifest v2：`package`（name/title/description/version/channel）规范化说明块，明文包同样携带；导入统计返回给 UI | `lib/project-config-bundle.ts` |
| 发布侧工具 | 内部项目 `apkg-publisher`（Go 二进制 + WebUI；pi-web 仓不再携带打包实现） |

### 发布方打包流程

发布侧已抽离为内部项目 `apkg-publisher`（Go，含 CLI 与 Web 工作台）：

```bash
# 1) 一客户一身份：私钥只留在发布方内部密钥库，公钥交给 pack
apkg-publisher identity new \
  --out publisher/keys/cust-acme-identity.json \
  --public-out publisher/keys/cust-acme-recipient.json

# 2) 打包（包信息优先读 zip 的 manifest.package / .pi/bundle.json）
apkg-publisher pack --in course-lab-config.zip --recipient publisher/keys/cust-acme-recipient.json \
  --buyer cust-acme --expires 2027-09-01 --max-imports 50

# 3) 本地工作台（回环监听；客户标识/公钥/输出目录启动时固定）
apkg-publisher serve --addr 127.0.0.1:8790 \
  --recipient publisher/keys/cust-acme-recipient.json --customer cust-acme \
  --out-dir data/apkg-output
# 每次打包写入 out-dir 并追加 history.jsonl / pack.log；页面可查历史、下载包。
# 上传 zip 后优先读 manifest.package；缺失时回退 .pi/bundle.json；两者都没有
# 则生成 .pi/bundle.json 模板（可复制/下载），提醒下次导出前放回项目。

# 4) 发布包：把该客户私钥封进“客户运行版”，随包只放公钥
apkg-publisher seal \
  --in apkg-publisher-runtime \
  --identity publisher/keys/cust-acme-identity.json \
  --out app/bin/apkg-publisher \
  --public-out app/config/apkg-recipient.json
# package-linux.sh 等价做法：
#   APKG_PUBLISHER_BIN=<完整版 apkg-publisher> \
#   APKG_PUBLISHER_RUNTIME_BIN=<apkg-publisher-runtime> \
#   APKG_IDENTITY_FILE=<cust-acme-identity.json> bash scripts/package-linux.sh
# 完整版只用于执行 seal，不随包分发；客户运行版只含 open / identity show，
# 不编译 WebUI、文档、硬化、打包/history/inspect 代码。脚本写
# config/apkg-recipient.json（仅公钥），私钥 JSON 不会进入发布包。
# 无需 Go 编译器，打包机上只要有完整版 + 运行版 + 客户私钥 JSON。
```

本地 dev 想直接用手上的私钥 JSON 验证解密，见
[apkg-dev-testing.md](apkg-dev-testing.md)（`PI_WEB_APKG_IDENTITY`，仅开发环境）。

### 版本管理与配置包说明规范

- **两种版本正交**：`formatVersion`（信封/manifest 结构兼容性，**当前 2，v1 不兼容**）与 `package.version`（内容版本，发布方自定，建议 semver）。列表/详情/导入结果统一展示 `package.version`。
- **说明字段**：`title`（展示名）+ `description`（一句话说明）随包分发；预置模板的描述字段与包内说明独立（前者是平台侧运营文案，后者是包自带的）。
- **渠道**：`channel`（stable/alpha/beta）仅供发布方管理分发线，导入侧不做限制。

### 诚实边界（实施后仍成立）

- 明文必然存在于项目 home（pi 运行时要读）；**agent 可以把 .pi/ 打 tar 包写入项目目录、用户经文件查看器下载**——这绕过一切产品层导出锁，属本方案明示不防的范围（要堵需禁 bash 或输出审查，代价远超收益）。
- 锁为**双门**：项目内 `.bundle-lock.json` + 服务端 `apkg-locked-homes.json` 登记（数据目录在 agent 写围栏外，删锁文件不再解锁）；但管理员可直接清登记（可接受，admin≈运营方），项目 home 被移动到新路径会脱离登记匹配（"复制为新项目"会连 `.pi/` 锁文件一起拷贝，兜住常见路径）。
- 导入计数是单服务器口径：包复制到另一台服务器重新计数。多服务器场景靠 `maxImports × 服务器数` 估算发放量，或未来升级为服务端发放计数。
- **私钥不再以明文文件随包分发**：封条只在解密进程内存中解开，复制数据目录/备份拿不到私钥。但客户拥有解密二进制，仍可把它当解密器使用，root 也可逆向/内存转储提取；封装提高的是随手复制与逆向成本，不是“防客户读取”。后者需要远程执行/在线许可。
