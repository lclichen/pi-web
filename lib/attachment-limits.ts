/** Chat composer attachment limits (client pre-check and remotefs server gate). */
export const MAX_CHAT_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** 每消息合计上限；与投影预算 PROJECTION_MAX_BYTES（64MB）保持一致（ADR-0004 §5.6）。 */
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 64 * 1024 * 1024;
/** Human label used in notices; keep in sync with MAX_CHAT_ATTACHMENT_BYTES. */
export const CHAT_ATTACHMENT_LIMIT_LABEL = "32MB";
