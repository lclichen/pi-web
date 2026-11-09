# Vendored from rpiv-mono

- 上游: `rpiv-mono/packages/rpiv-ask-user-question` @ 2.15.0 (2026-10-24)
  及其硬依赖 `rpiv-mono/packages/rpiv-config` @ 2.15.0（内联于
  node_modules/@juicesharp/，仅保留所需源码）。
- 同步方式: 覆盖本目录（保留 VENDORED.md）；上游测试文件不随包分发。
  上游 `.ts` 导入说明符可直接保留（仓库 tsconfig 已开
  `allowImportingTsExtensions`，jiti 也能解析）；同步后跑 Prettier。
- 入口: package.json `pi.extensions = ["./index.ts"]` —— pi 启动时自动发现加载，
  pi-web 会话经 RPC 回退（rpc-fallback.ts）把问卷渲染为阻塞对话框。
- 软依赖 @juicesharp/rpiv-i18n 缺失时自动降级英文文案（i18n-bridge shim）。
- **本地补丁（pi-web，仅 rpc-fallback.ts）**：
  - 自定义答案行追加不可见后缀 `CUSTOM_ROW_MARKER`，并接受
    `${CUSTOM_ROW_MARKER}<text>` 作为内联回答；pi-web 据此在原对话框内展开
    输入框，不再弹第二个输入框。2.15 的自由文本回答会保留该前缀，需先剥离。
  - 多选：宿主声明 `supportsMultiSelect` 时改用 `select` + 复选框，响应为
    `MULTI_SELECT_RESPONSE_MARKER` + JSON；其他宿主继续走 2.15 的
    `ui.input` 逗号 + `; 自定义文本` 路径。
  - 同步上游时先覆盖 `rpc-fallback.ts`，再把上面两段补丁重新贴回。

