/**
 * amedac-sandbox — sandbox-platform 桥接扩展的加载入口。
 *
 * 实现本体已并入 amedac-core 源码树（../amedac-core/src/sandbox/，2026-10-08
 * 整合决策：统一代码管理，原独立仓库 LabTrainingProject/pi-sandbox-extension
 * 归档不再演化）。保持独立加载目录而非并入 amedac-core 主聚合，是因为沙盒
 * 工具路由必须只在沙盒会话中生效——常规会话注入它会改写 read/write/bash 的
 * 执行目标并注册容器 LLM provider。
 *
 * 加载方式（与原独立扩展一致，零行为变化）：
 *   pi-web  — 沙盒模式会话经 PI_WEB_SANDBOX_EXTENSION_PATH 指向本目录注入；
 *   pi CLI  — 需要时 ln -s 本目录 ~/.pi/agent/extensions/amedac-sandbox 或
 *             在项目的 .pi/extensions/ 内链接。
 */
export { default } from "../amedac-core/src/sandbox/index.ts";
