/**
 * Embed session-widget shared types.
 *
 * An embed token binds the caller to ONE workspace (project or host directory)
 * and one product profile. The page and the API fence both read these shapes;
 * they intentionally contain no platform credentials.
 */

export type EmbedMode = "host" | "sandbox" | "local-machine" | "ssh" | "quick";

/** Container-size mode used by the embed shell / chat composer. */
export type EmbedDensity = "comfortable" | "compact" | "mini";

export type EmbedScope =
  | { kind: "project"; projectId: string; cwd: string }
  | { kind: "host"; cwd: string };

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
  /** Parent origins allowed by the page CSP frame-ancestors. Empty = any. */
  allowedOrigins: string[];
  enabled: boolean;
}

export interface EmbedTokenRecord {
  id: string;
  /** sha256(raw token) — the raw token is only returned at creation. */
  tokenHash: string;
  ownerId: number;
  user: EmbedUser;
  productId: string;
  scope: EmbedScope;
  /** File roots this token may touch (project home or the bound directory). */
  allowedRoots: string[];
  mode: EmbedMode;
  label: string;
  /** Dedicated platform key minted for this token (empty in auth-off mode). */
  apiKey: string;
  apiKeyId: number | string;
  createdAt: number;
  expiresAt: number;
}

export interface EmbedTokenView {
  id: string;
  ownerId: number;
  ownerName: string;
  productId: string;
  scope: EmbedScope;
  label: string;
  mode: EmbedMode;
  createdAt: number;
  expiresAt: number;
}

export interface EmbedPageContext {
  token: string;
  product: { id: string; name: string };
  scope: EmbedScope;
  label: string;
  mode: EmbedMode;
  allowedCommands: string[];
  expiresAt: number;
  initialSessionId?: string;
}
