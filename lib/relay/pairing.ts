import { randomBytes } from "node:crypto";

// Crockford Base32, ambiguous characters removed (no 0/O/1/I/L). Keeps the
// code short, unambiguous when read aloud or typed on CentOS, and case-folded.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".replace("0", "").replace("O", "").replace("I", "").replace("L", "");
const CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a human-friendly 6-char pairing code. Single-use, short-lived
 * (5 min), and exchanged for the real secret (the agent token) over an
 * authenticated step. Rejection sampling keeps the uniform distribution
 * (256 % 31 = 8 would otherwise bias the first 8 alphabet characters).
 */
export function generatePairingCode(): string {
  const max = 256 - (256 % ALPHABET.length); // first multiple of the base ≤ 256
  let out = "";
  while (out.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH * 2);
    for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
      if (bytes[i] < max) out += ALPHABET[bytes[i] % ALPHABET.length];
    }
  }
  return out;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
