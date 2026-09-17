# Vendored from rpiv-mono

- 上游: `rpiv-mono/packages/rpiv-ask-user-question` @ 2.10.1 (2026-09-17)
  及其硬依赖 `rpiv-mono/packages/rpiv-config`（内联于 node_modules/@juicesharp/，
  仅保留 loadJsonConfigWithLegacyFallback / validateGuidanceFields 所需源码）。
- 同步方式: 覆盖本目录（保留 VENDORED.md）；上游测试文件不随包分发。
- 入口: package.json `pi.extensions = ["./index.ts"]` —— pi 启动时自动发现加载，
  pi-web 会话经 RPC 回退（rpc-fallback.ts）把问卷渲染为阻塞对话框。
- 软依赖 @juicesharp/rpiv-i18n 缺失时自动降级英文文案（i18n-bridge shim）。
