import { randomBytes } from "node:crypto";

// Crockford Base32, ambiguous characters removed (no 0/O/1/I/L). Keeps the
// code short, unambiguous when read aloud or typed on CentOS, and case-folded.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".replace("0", "").replace("O", "").replace("I", "").replace("L", "");
const CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a human-friendly 6-char pairing code. Not cryptographically the
 * strongest possible, but the code is single-use, short-lived (5 min), and
 * only grants the *ability to register an agent* — it is exchanged for the
 * real secret (the agent token) over an authenticated step.
 */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
