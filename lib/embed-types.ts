/**
 * Embedded product integration shared types.
 *
 * Project ids are stable references, not credentials. A product holds the
 * end-user's platform API key and exchanges it for a short-lived access token;
 * the page URL only carries that access token in its hash.
 */

export type EmbedMode = "host" | "sandbox" | "local-machine" | "ssh" | "quick";

/** Container-size mode used by the embed shell / chat composer. */
export type EmbedDensity = "comfortable" | "compact" | "mini";

export type EmbedScope = {
  kind: "project";
  projectId: string;
  /** Server-side project home (SDK cwd). */
  cwd: string;
};

export interface EmbedUser {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: string;
}

export interface EmbedProductProfile {
  id: string;
  name: string;
  /** Command names without the leading slash. `*` allows every command. */
  allowedCommands: string[];
  /** Parent origins allowed by iframe/CORS. Empty = any. */
  allowedOrigins: string[];
  enabled: boolean;
  /** Product user group. Absent = every active user (legacy default). */
  members?: number[];
  /** Fixed Agent config bundle applied to new workspaces. */
  configBundle?: string | null;
  /** Default mode for product-created projects. */
  defaultMode?: "local-machine" | "sandbox" | "ssh";
}

export interface EmbedProjectBinding {
  productId: string;
  clientId: string;
  externalRef: string;
  bundleName?: string;
  bundleVersion?: string;
  bundleSha256?: string;
  createdAt: number;
}

/** Short-lived in-memory credential issued by API-key exchange. */
export interface EmbedAccessRecord {
  id: string;
  tokenHash: string;
  userId: number;
  user: EmbedUser;
  /** The user's platform API key, held in memory for BFF calls. */
  apiKey: string;
  productId: string;
  scope: EmbedScope;
  allowedRoots: string[];
  mode: EmbedMode;
  label: string;
  createdAt: number;
  expiresAt: number;
}

export interface EmbedProjectView {
  id: string;
  name: string;
  mode: EmbedMode;
  clientId: string;
  externalRef: string;
  bundleName: string | null;
  bundleVersion: string | null;
  configUpdateAvailable: boolean;
  createdAt: number;
}

export interface EmbedPageContext {
  product: { id: string; name: string };
  project: { id: string; name: string; mode: EmbedMode };
  scope: EmbedScope;
  label: string;
  allowedCommands: string[];
  configUpdateAvailable: boolean;
  initialSessionId?: string;
}

export interface EmbedAuthResponse {
  token: string;
  expiresAt: number;
  user: { id: number; username: string };
  product: { id: string; name: string };
  project: { id: string; name: string; mode: EmbedMode };
  allowedCommands: string[];
  configUpdateAvailable: boolean;
}
