import type { OCRWord } from "../lib/detectPatterns";

/** Lay text out as fake OCR words: one row per line, words separated by a space, 10px per character. */
export function ocrLines(lines: string[], opts: { lineHeight?: number; gapAfter?: Record<number, number> } = {}): OCRWord[] {
  const lineHeight = opts.lineHeight ?? 20;
  const words: OCRWord[] = [];
  let y = 10;
  lines.forEach((line, row) => {
    let x = 10;
    for (const text of line.split(/\s+/).filter(Boolean)) {
      words.push({ text, bbox: { x0: x, y0: y, x1: x + text.length * 10, y1: y + lineHeight - 4 } });
      x += text.length * 10 + 10;
    }
    y += lineHeight + 6 + (opts.gapAfter?.[row] ?? 0);
  });
  return words;
}

/** Small deterministic PRNG so "random" test strings are the same on every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomString(next: () => number, length: number, alphabet: string) {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

export const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const B64URL = B64 + "-_";
export const HEXCHARS = "0123456789abcdef";
