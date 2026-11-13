import {
  ATTACHMENTS_DIR,
  attachmentFileName,
  attachmentsTarget,
  ensureUploadDirectory,
  mentionText,
  uploadFiles,
  type UploadTarget,
} from "./file-upload-client";
import {
  CHAT_ATTACHMENT_LIMIT_LABEL,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "./attachment-limits";

/**
 * Chat composer attachment upload, independent of React so the behaviour is
 * testable and the component only wires callbacks.
 *
 * - Every attachment gets a unique stored name (`timestamp-random-original`),
 *   so re-attaching a same-named file never overwrites an older one.
 * - Non-image files are uploaded into the working directory and mentioned;
 *   images also reach the model inline.
 * - Remote sessions keep the Host primary copy under .pi/attachments/ and
 *   mirror it into the workspace; images are stored the same way now that the
 *   remote write channel is binary-safe.
 */

export interface ChatAttachmentNotice {
  type: "success" | "warning" | "error";
  message: string;
}

export interface ChatAttachmentHooks {
  addNotice: (notice: ChatAttachmentNotice) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Appends `@path` mentions to the composer. */
  insertText: (text: string) => void;
  /** At least one file was written into the workspace. */
  onUploaded?: () => void;
}

export interface AttachmentUploadApi {
  uploadFiles: typeof uploadFiles;
  ensureUploadDirectory: typeof ensureUploadDirectory;
}

const defaultApi: AttachmentUploadApi = { uploadFiles, ensureUploadDirectory };

export async function uploadChatAttachments(
  target: UploadTarget,
  files: File[],
  images: File[],
  hooks: ChatAttachmentHooks,
  api: AttachmentUploadApi = defaultApi,
): Promise<void> {
  let uploadedAny = false;
  const mentions: string[] = [];
  // Remote chat uploads keep their primary copy on the Host ("项目区") and
  // mirror it into the remote workspace; host sessions already write locally.
  const uploadOptions = { hostCache: Boolean(target.sessionId) };

  const oversized = [...files, ...images].filter((file) => file.size > MAX_CHAT_ATTACHMENT_BYTES);
  if (oversized.length > 0) {
    hooks.addNotice({
      type: "warning",
      message: hooks.t("chat.dropTooLarge", {
        size: CHAT_ATTACHMENT_LIMIT_LABEL,
        names: oversized.map((file) => file.name).join(", "),
      }),
    });
  }
  const acceptedFiles = files.filter((file) => file.size <= MAX_CHAT_ATTACHMENT_BYTES);
  const acceptedImages = images.filter((file) => file.size <= MAX_CHAT_ATTACHMENT_BYTES);

  const reportHostOnly = (names: string[], data: { hostDir?: string; warning?: string }) => {
    if (names.length === 0) return;
    hooks.addNotice({
      type: "warning",
      message: hooks.t("chat.dropHostOnly", {
        names: names.join(", "),
        dir: data.hostDir ?? "",
        message: data.warning ?? "",
      }),
    });
  };
  const reportHostWarning = (data: { warning?: string }) => {
    if (!data.warning) return;
    hooks.addNotice({ type: "warning", message: hooks.t("chat.dropHostWarning", { message: data.warning }) });
  };

  if (acceptedFiles.length > 0) {
    try {
      const names = acceptedFiles.map((file) => attachmentFileName(file));
      const { status, data } = await api.uploadFiles(target, acceptedFiles, "skip", names, uploadOptions);
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const hostOnly = data.hostOnly ?? [];
      const mention = mentionText([...uploaded, ...skipped].filter((name) => !hostOnly.includes(name)));
      if (mention) mentions.push(mention);
      if (uploaded.length > 0) {
        uploadedAny = true;
        hooks.addNotice({ type: "success", message: hooks.t("chat.dropUploaded", { count: uploaded.length }) });
      }
      if (skipped.length > 0) {
        hooks.addNotice({
          type: "warning",
          message: hooks.t("chat.dropAlreadyExists", { names: skipped.join(", ") }),
        });
      }
      reportHostOnly(hostOnly, data);
      if (hostOnly.length === 0) reportHostWarning(data);
      for (const failure of data.errors ?? []) {
        hooks.addNotice({
          type: "error",
          message: hooks.t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }),
        });
      }
    } catch (error) {
      hooks.addNotice({
        type: "error",
        message: hooks.t("chat.dropFailed", { message: error instanceof Error ? error.message : String(error) }),
      });
    }
  }

  if (acceptedImages.length > 0) {
    try {
      const imageDirectory = attachmentsTarget(target);
      if (!(await api.ensureUploadDirectory(imageDirectory))) throw new Error(`Cannot create ${ATTACHMENTS_DIR}`);
      const names = acceptedImages.map((file) => attachmentFileName(file));
      const { status, data } = await api.uploadFiles(imageDirectory, acceptedImages, "skip", names, uploadOptions);
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const hostOnly = new Set(data.hostOnly ?? []);
      const stored = new Set([...(data.uploaded ?? []), ...(data.skipped ?? [])]);
      const paths = names
        .filter((name) => stored.has(name) && !hostOnly.has(name))
        .map((name) => `${ATTACHMENTS_DIR}/${name}`);
      if (paths.length > 0) {
        mentions.push(mentionText(paths));
        uploadedAny = true;
      }
      reportHostOnly([...hostOnly], data);
      if (hostOnly.size === 0) reportHostWarning(data);
      for (const failure of data.errors ?? []) {
        hooks.addNotice({
          type: "error",
          message: hooks.t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }),
        });
      }
    } catch (error) {
      hooks.addNotice({
        type: "error",
        message: hooks.t("chat.dropFailed", { message: error instanceof Error ? error.message : String(error) }),
      });
    }
  }

  const mention = mentions.join("");
  if (mention) hooks.insertText(mention);
  if (uploadedAny) hooks.onUploaded?.();
}
