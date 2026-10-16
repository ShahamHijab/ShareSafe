import { COMMON_ENGLISH } from "./englishWords";

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-fA-F]+$/;
const TOKEN_CHARS = /^[A-Za-z0-9+/_-]+={0,2}$/;
// Words near a hex string that mean "this is a public identifier", not a secret.
const HASH_CONTEXT = /\b(?:commit|sha\d*|md5|hash|checksum|digest|revision|rev|etag|integrity|fingerprint)\b/i;

/** Strip wrapping quotes/brackets/trailing punctuation that OCR and prose leave around a token. */
export function trimToken(raw: string): string {
  return raw.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>,;:.!?]+$/, "");
}

/** Fraction of a token's letters that belong to ordinary English words (camelCase / snake_case aware). */
function wordCoverage(token: string): number {
  const runs = token
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  const letters = runs.reduce((n, run) => n + run.length, 0);
  if (!letters) return 0;
  const covered = runs.reduce((n, run) => n + (run.length >= 3 && COMMON_ENGLISH.has(run.toLowerCase()) ? run.length : 0), 0);
  return covered / letters;
}

function entropyThreshold(length: number): number {
  // A random string of n symbols cannot exceed log2(n) bits/char, so short tokens need a lower bar.
  if (length < 24) return 3.7;
  if (length < 32) return 3.95;
  return 4.15;
}

export type EntropyVerdict = { random: boolean; entropy: number; kind?: "hex" | "token" };

/**
 * Decide whether one whitespace-free token looks like a randomly generated secret.
 * `context` is the surrounding line text, used only to spare git SHAs and checksums.
 */
export function assessToken(raw: string, context = ""): EntropyVerdict {
  const token = trimToken(raw);
  const no = { random: false, entropy: 0 };
  if (token.length < 20 || token.length > 256) return no;
  if (!TOKEN_CHARS.test(token)) return no; // dots, spaces, colons etc. => URLs, paths, versions, prose
  if (UUID.test(token)) return no;

  const entropy = shannonEntropy(token);
  const letters = (token.match(/[A-Za-z]/g) ?? []).length;
  const digits = (token.match(/\d/g) ?? []).length;
  if (letters < 8) return { random: false, entropy }; // dates, serial numbers, long digit runs

  if (HEX.test(token)) {
    if (token.length < 32 || HASH_CONTEXT.test(context)) return { random: false, entropy };
    return { random: entropy >= 3.0, entropy, kind: "hex" };
  }

  if (token.includes("/") && (token.match(/\//g) ?? []).length >= 2 && digits === 0) return { random: false, entropy };

  const upper = (token.match(/[A-Z]/g) ?? []).length;
  const lower = (token.match(/[a-z]/g) ?? []).length;
  const mixedCase = upper >= 3 && lower >= 3;
  if (!(digits >= 2 || mixedCase)) return { random: false, entropy }; // single-class text is rarely a key
  if (digits === 0) {
    // Letters only: demand a believable upper/lower mix so ordinary camelCase doesn't qualify.
    const ratio = upper / (upper + lower);
    if (ratio < 0.25 || ratio > 0.75) return { random: false, entropy };
  }
  if (wordCoverage(token) >= 0.5) return { random: false, entropy }; // readable identifier, not random
  return { random: entropy >= entropyThreshold(token.length), entropy, kind: "token" };
}
