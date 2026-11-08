# Vendored from rpiv-mono

- 上游: `rpiv-mono/packages/rpiv-ask-user-question` @ 2.10.1 (2026-09-17)
  及其硬依赖 `rpiv-mono/packages/rpiv-config`（内联于 node_modules/@juicesharp/，
  仅保留 loadJsonConfigWithLegacyFallback / validateGuidanceFields 所需源码）。
- 同步方式: 覆盖本目录（保留 VENDORED.md）；上游测试文件不随包分发。
- 入口: package.json `pi.extensions = ["./index.ts"]` —— pi 启动时自动发现加载，
  pi-web 会话经 RPC 回退（rpc-fallback.ts）把问卷渲染为阻塞对话框。
- 软依赖 @juicesharp/rpiv-i18n 缺失时自动降级英文文案（i18n-bridge shim）。
- **本地补丁（pi-web）**：`rpc-fallback.ts` 在自定义答案行追加不可见后缀
  `CUSTOM_ROW_MARKER`，并接受 `${CUSTOM_ROW_MARKER}<text>` 作为内联回答；
  pi-web 据此在原对话框内展开输入框，不再弹第二个输入框。
  多选同理：宿主声明 `supportsMultiSelect` 时改用 `select` + 复选框，
  响应为 `MULTI_SELECT_RESPONSE_MARKER` + JSON；其他宿主保持原 `ui.input`
  逗号输入。同步上游时需保留。
