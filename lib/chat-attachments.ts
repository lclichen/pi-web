import {
  ATTACHMENTS_DIR,
  attachmentFileName,
  attachmentsTarget,
  dropMentionText,
  ensureUploadDirectory,
  mentionText,
  uploadFiles,
  type UploadTarget,
} from "./file-upload-client";

/**
 * Chat composer attachment upload, independent of React so the behaviour is
 * testable and the component only wires callbacks.
 *
 * - Non-image files are uploaded into the working directory (conflict=skip)
 *   and mentioned; images still reach the model inline.
 * - In HOST sessions the image bytes are also stored under .pi/attachments/
 *   and mentioned, so tools (including MCP servers that take a file path) can
 *   use them. Remote sessions keep images inline only: the relay/SSH write
 *   channel is text-only, so uploading binary bytes there would corrupt them.
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

  if (files.length > 0) {
    try {
      const { status, data } = await api.uploadFiles(target, files, "skip", undefined, uploadOptions);
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const hostOnly = data.hostOnly ?? [];
      const mention = dropMentionText(
        files.filter((file) => !hostOnly.includes(file.name)),
        [...uploaded, ...skipped],
      );
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

  if (images.length > 0) {
    try {
      const imageDirectory = attachmentsTarget(target);
      if (!(await api.ensureUploadDirectory(imageDirectory))) throw new Error(`Cannot create ${ATTACHMENTS_DIR}`);
      const names = images.map((file) => attachmentFileName(file));
      const { status, data } = await api.uploadFiles(imageDirectory, images, "skip", names, uploadOptions);
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
