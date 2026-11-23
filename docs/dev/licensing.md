# 分发许可与第三方归属

> 状态：现行（2026-11-23）。记录随产品分发的组件、修改关系、特殊许可证义务和发布检查。
> 完整包清单见仓库根 `THIRD_PARTY_NOTICES.md`，许可证全文见 `LICENSES/`。
> 本文是工程合规文档，不构成法律意见；商业分发前应由发布方律师复核。

## 1. 组件与修改关系

| 组件 | 版本 | 许可证 | 分发形态 | 修改/说明 |
|---|---|---|---|---|
| pi-web / Amedac Agent Platform | 0.9.0（dev-0.85.1） | MIT | WebUI/控制面 | 基于 agegr/pi-web 的大幅修改；保留上游 LICENSE |
| Agent Client（`agent/`） | 0.8.0 | MIT | 五平台二进制 | pi-web 一部分；Go 依赖见下 |
| @tintinweb/pi-subagents | 0.19.0 | MIT | pi 配置模板/npm | lclichen fork：sessionId/空间对齐、子扩展桥、右栏 viewer |
| pi-mcp-adapter | 2.38.0 | MIT | pi 配置模板/npm | lclichen fork：session/user 身份注入、内联图片规范化 |
| @juicesharp/rpiv-ask-user-question | 2.15.0 | MIT | vendored 于 `pi-config` | 本地 RPC 补丁见 `VENDORED.md` |
| pi-codex-goal | 0.7.10 | MIT | 可选扩展 | 上游未修改；不随核心包默认携带 |
| pi-smart-compact | 10.8.1 | MIT | 可选扩展 | 上游未修改；当前 pi-web 无运行时引用，可不分发 |
| sandbox-platform | 0.2.0 | MIT | 可选沙盒组件 | 平台 API/容器管理 |

上游/许可证全文在 `LICENSES/components/`。

## 2. 特殊许可证依赖

| 依赖 | 版本 | 许可证 | 义务 |
|---|---|---|---|
| `@img/sharp-libvips-linux-x64`（及 musl） | 1.3.3 | LGPL-3.0-or-later | **标准 Linux 包已默认移除**（`images.unoptimized=true`）；若启用 Next 图片优化或自行安装 sharp，则需随包附 LGPL/GPL 文本、libvips 源码或书面要约，并允许替换/重链接 |
| `@img/sharp-linux-x64` / sharp | 0.35.4 | Apache-2.0 | 同上；启用图片优化时附 Apache-2.0 文本并保留上游 NOTICE |
| `web-push` | 3.6.7 | MPL-2.0 | 附 MPL 文本；修改 MPL 文件需公开修改源码 |
| `caniuse-lite` | 1.0.30001809 | CC-BY-4.0 | 保留署名与 CC-BY 文本；通常为构建期依赖，若打包则仍需归属 |
| `dompurify` | 3.4.15 | MPL-2.0 OR Apache-2.0 | 本分发按 Apache-2.0 分支使用；附 Apache 文本 |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later | 本分发按 MIT 分支使用 |
| `expand-template` | 2.0.3 | MIT OR WTFPL | 本分发按 MIT 分支使用 |
| `argparse` | 2.0.1 | Python-2.0 | 附 Python-2.0 文本 |
| `fast-sha256` / `tweetnacl` | — | Unlicense | 附 Unlicense 文本 |
| `lru-cache` / `minimatch` / `glob` / `path-scurry` / `minipass` | — | BlueOak-1.0.0 | 附 BlueOak 文本 |
| `tslib` | 2.8.1 | 0BSD | 附 0BSD 文本 |
| `@resvg/resvg-js` | 2.6.2 | MPL-2.0 | pi-smart-compact 的可选 peer；只有实际分发时才需要 |
| `@oh-my-pi/pi-mnemopi` | 19.x | MIT | pi-smart-compact 的可选 peer |

说明：

- 当前标准 Linux 包在 `slim-package.sh` 中检测到 `images.unoptimized=true`，会移除
  `sharp`/`@img/sharp-*`/`@img/colour`，因此**不实际分发 libvips**；`LICENSES/` 中的
  LGPL 材料仍保留给启用图片优化、`SLIM_PACKAGE=0` 构建或自行安装 sharp 的变体。
- `@img/sharp-libvips` 的 npm 包本身不带 LICENSE 文件；如果分发，仓库根 `LICENSES/`
  必须随包分发，不能只依赖 `node_modules`。
- libvips 是动态加载的共享库；LGPL 合规的关键是保留替换能力、提供对应源码/要约，而不是把整个 pi-web 改成 LGPL。
- `sharp` 本身是 Apache-2.0；`sharp-libvips` 是 LGPL-3.0-or-later，两者不要混淆。
- `sharp-win32-x64` 等非 Linux 平台包未随 Linux 发布包分发；如果制作 Windows 包，需要单独复核。

## 3. 扩展的当前取舍

### pi-smart-compact

当前 pi-web 代码没有运行时引用（只有 bench 文档提及）。`pi-config` 默认也不包含它。
**如果分发配置中没有它，就不需要把它的可选 peer（`@resvg/resvg-js` MPL-2.0）纳入包。**
如果仍随配置模板分发，需包含其 MIT LICENSE 与可选 peer 的许可证文本。

### pi-codex-goal

上游 MIT，无运行时依赖；只有实际放入 `~/.pi/agent/npm` 或配置模板时才随包分发。
没有修改时只需保留上游 LICENSE/NOTICE。

### pi-subagents / pi-mcp-adapter / rpiv

它们是当前产品运行所需/随配置模板分发的扩展。不要只复制 `dist` 或 `.js` 而丢掉
`LICENSE`、`README` 中的归属；fork 修改关系在 `NOTICE` 中声明。

## 4. 包内必须携带的文件

发布包根目录至少包含：

```
LICENSE
NOTICE
THIRD_PARTY_NOTICES.md
LICENSES/
  README.md
  Apache-2.0.txt
  LGPL-3.0-or-later.txt
  GPL-3.0-only.txt
  MPL-2.0.txt
  CC-BY-4.0.txt
  ...
  components/*-LICENSE.txt
```

`scripts/package-linux.sh` 已把上述文件复制到包根；`slim-package.sh` 不会删除它们。
`node_modules` 中的逐包 `LICENSE*` 也是合规材料，瘦身/重打包时不得批量删除。

## 5. 发布检查清单

1. 生成/更新 `THIRD_PARTY_NOTICES.md`（从实际生产依赖树，而不是只看 package.json）；
2. 确认 `LICENSES/` 与 `NOTICE` 已进包；
3. Linux 包包含 `@img/sharp-libvips-linux-x64` 的 LGPL 文本/source offer；
4. 若分发 `pi-smart-compact`，补 `@resvg/resvg-js` MPL 文本；不分发则从配置模板移除；
5. 若修改 `web-push` 等 MPL 文件，公开修改源码；
6. 保留 `caniuse-lite` 的 CC-BY 署名；
7. 更新组件版本/修改说明（本文件 + `NOTICE`）；
8. 商业发布前让法务复核 LGPL source offer 与最终包实际内容。

## 6. 生成方式

`THIRD_PARTY_NOTICES.md` 由 `license-checker` 对以下生产树生成：

- pi-web（390 个生产包）
- @tintinweb/pi-subagents（161）
- pi-mcp-adapter（206）
- @juicesharp/rpiv-ask-user-question（2）
- sandbox-platform（167）

`pi-codex-goal` 与 `pi-smart-compact` 没有随包运行时依赖，单独列在组件表；
`@resvg/resvg-js` 等可选 peer 在特殊义务表中说明。

重新生成时不要手工删减条目；若依赖树变化，重新跑 license-checker 并复核特殊许可证。
