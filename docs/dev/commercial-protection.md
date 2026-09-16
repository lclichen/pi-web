# 商业化保护方案（项目本体 + 配置包）

> 状态：方案设计（待分期实施）。目标读者：需要对外商业化分发的部署/开发。
> 威胁模型先说清楚：**所有客户端/本地保护都只能提高门槛，不能做到绝对**——
> 攻击者拥有目标机 root 权限时，任何本地校验都可被绕过。方案按「防普通用户
> 误扩散 / 防低成本转卖」设计，关键秘密全部收敛在发布方与服务端。

## 一、配置包加密（加密导出 / 导入 / 禁止再导出）

### 格式：`.apkg`（加密配置包）

在现有 zip 明文包外再包一层信封加密：

```
[16B magic "APKG1"] [2B ver] [16B keyId] [12B nonce] [AES-256-GCM ciphertext] [16B tag]
```

- **明文 zip 内容**：与现有 config bundle 完全一致（.pi/ + labs/ + manifest.json）。
- **信封加密**：每包随机生成 256-bit 包密钥（DEK）加密内容；DEK 用主密钥（KEK，
  发布方持有，存放于打包机/发布服务，绝不进分发包）做 AES-GCM 包装，`keyId`
  标识用的是哪一代 KEK——支持轮换与吊销。
- **元信息**：ciphertext 的前 4KB 预留明文 JSON（版本、项目名、允许的导入次数、
  过期时间、channel），便于导入界面展示与授权判断（不可信，仅展示）。

### 导入侧（pi-web）

1. `POST /api/bundles`（与 config-import）识别 `.apkg`：解密 DEK → 解密 zip →
   校验 tag → 走现有导入流程（凭证剥离等不变）。
2. 导入成功后在项目 home 写 `.pi/.bundle-lock.json`：
   ```json
   { "apkg": true, "keyId": "…", "fingerprint": "sha256(包)", "importedAt": … }
   ```
3. **禁止再导出**：`/api/projects/:id/config-export` 与 Host 目录导出检测到
   `.bundle-lock.json` 即 403（响应明确提示「加密配置包不允许再导出」）。
   发布方内部流转用服务端命令行工具解除（不走 Web API）。
4. 同理 `/api/bundles` 的「预置模板」若由加密包上传，落盘保存密文原件，
   每次套用走内存解密，不落明文。

### 密钥管理

- KEK 存发布侧（打包机 keychain / 发布服务 env），分代保存；泄露一代不影响其他代。
- 目标机只需要**公钥级能力**（解密用 KEK 派生的包密钥由服务端在导入 API 内
  完成——KEK 不出服务器；单机离线导入场景则内嵌一代 KEK 于打包产物，接受
  「拥有产物即可解密」的降级）。

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

- 前端 DRM/防截屏——教学产品内容本就展示给学生。
- 对拥有 root 的目标机做强对抗（VM 探测/反调试军备竞赛）——成本高且伤正常用户。
