/** Chat composer attachment limits (client pre-check and remotefs server gate). */
export const MAX_CHAT_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
/** Human label used in notices; keep in sync with MAX_CHAT_ATTACHMENT_BYTES. */
export const CHAT_ATTACHMENT_LIMIT_LABEL = "32MB";
