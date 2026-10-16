import jsQR from "jsqr";
import type { Detection, Rect } from "./types";

// ---------------------------------------------------------------------------
// QR code and barcode finding.
//
// OCR cannot read these, but they often carry payment links, 2FA seeds, Wi-Fi passwords, tickets
// and login tokens. Two decoders run on the pixels, entirely in the browser:
//   * jsQR       - QR codes (pure JavaScript, works everywhere).
//   * zxing-wasm - 1D barcodes (EAN/UPC, Code 128/39, ITF...) and 2D formats (Data Matrix, PDF417,
//                  Aztec), plus QR as a second opinion. It loads a ~1 MB WebAssembly file that is
//                  served from this site (public/zxing_reader.wasm), not from a CDN.
// The decoded text is used for the review list; the decoder's corner points give the box to redact.
// ---------------------------------------------------------------------------

export type Raster = { data: Uint8ClampedArray; width: number; height: number };
export type CodeHit = { kind: "QR code" | "Barcode"; format: string; payload: string; rect: Rect };
export type ScanResult = { hits: CodeHit[]; barcodeEngine: "ready" | "unavailable" };
type Source = HTMLImageElement | HTMLCanvasElement;

const MAX_SIDE = 3000; // largest raster handed to a decoder in one go
const TILE = 2400;
const TILE_OVERLAP = 400;
const MAX_TILES = 16;
const SMALL_SIDE = 1400; // below this, also try a 2x upscale so tiny codes get enough pixels per module
const MIN_CODE_PX = 12;

// ---- barcode engine (zxing-wasm), loaded lazily and only in the browser ----

type ZXingOverrides = Record<string, unknown>;
let engineOverrides: ZXingOverrides | undefined;
let enginePromise: Promise<typeof import("zxing-wasm/reader")> | null = null;
let engineFailed = false;

/** Tests (and unusual deployments) can point the engine at a different wasm location or binary. */
export function configureBarcodeEngine(overrides: ZXingOverrides | undefined) {
  engineOverrides = overrides;
  enginePromise = null;
  engineFailed = false;
}

function loadEngine() {
  if (engineFailed) return null;
  enginePromise ??= import("zxing-wasm/reader").then(async (mod) => {
    await mod.prepareZXingModule({
      overrides: engineOverrides ?? {
        locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? "/zxing_reader.wasm" : prefix + path),
      },
      fireImmediately: true,
    });
    return mod;
  });
  enginePromise.catch(() => { engineFailed = true; });
  return enginePromise;
}

// ---- geometry helpers ----

function boundsOf(points: { x: number; y: number }[], pad: number): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, width: Math.max(...xs) + pad - x0, height: Math.max(...ys) + pad - y0 };
}

function padFor(points: { x: number; y: number }[]): number {
  const b = boundsOf(points, 0);
  // A little extra so a decoder's tight corner points never leave a sliver of the code visible.
  return Math.max(4, Math.round(Math.max(b.width, b.height) * 0.06));
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (w * h) / smaller : 0;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function transform(hit: CodeHit, scale: number, dx: number, dy: number): CodeHit {
  const r = hit.rect;
  return { ...hit, rect: { x: r.x / scale + dx, y: r.y / scale + dy, width: r.width / scale, height: r.height / scale } };
}

function clampTo(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return { x, y, width: Math.min(width, rect.x + rect.width) - x, height: Math.min(height, rect.y + rect.height) - y };
}

// ---- decoders (operate on a raw RGBA raster so they can be tested without a browser) ----

function decodeText(result: { data: string; binaryData: number[] }): string {
  if (result.data) return result.data;
  try { return new TextDecoder("utf-8").decode(Uint8Array.from(result.binaryData)); } catch { return ""; }
}

function paintWhite(data: Uint8ClampedArray, width: number, height: number, rect: Rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    const row = y * width * 4;
    for (let x = x0; x < x1; x++) { const o = row + x * 4; data[o] = data[o + 1] = data[o + 2] = 255; data[o + 3] = 255; }
  }
}

/** Run jsQR over `data` (modified in place). It returns one code per call, so paint each find white and look again. */
function decodeQRRegion(data: Uint8ClampedArray, width: number, height: number, max: number): CodeHit[] {
  const hits: CodeHit[] = [];
  for (let i = 0; i < max; i++) {
    const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
    if (!result) break;
    const l = result.location;
    const points = [
      l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner,
      l.topLeftFinderPattern, l.topRightFinderPattern, l.bottomLeftFinderPattern,
    ];
    const rect = clampTo(boundsOf(points, padFor(points)), width, height);
    hits.push({ kind: "QR code", format: "QR Code", payload: decodeText(result), rect });
    paintWhite(data, width, height, rect);
  }
  return hits;
}

function cropRaster(raster: Uint8ClampedArray, rasterWidth: number, x: number, y: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * rasterWidth + x) * 4;
    out.set(raster.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}

/**
 * Find QR codes with jsQR. Its finder-pattern search gives up entirely when several codes share an
 * image (each decodes fine alone), so this works in rounds on a private copy of the pixels: scan the
 * whole image, then overlapping tiles about half the image across, painting every code white as soon
 * as it is found. Each round leaves fewer codes to confuse the locator, until nothing new turns up.
 */
export function decodeQR(raster: Raster, max = 12): CodeHit[] {
  const { width, height } = raster;
  const work = new Uint8ClampedArray(raster.data);
  const side = Math.max(width, height);
  const tileW = Math.min(width, Math.max(320, Math.round(side / 2)));
  const tileH = Math.min(height, Math.max(320, Math.round(side / 2)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x + tileW < width; x += Math.max(1, Math.round(tileW / 2))) xs.push(x);
  xs.push(width - tileW);
  for (let y = 0; y + tileH < height; y += Math.max(1, Math.round(tileH / 2))) ys.push(y);
  ys.push(height - tileH);
  const useTiles = xs.length * ys.length > 1 && xs.length * ys.length <= 25;

  const hits: CodeHit[] = [];
  for (let round = 0; round < 3 && hits.length < max; round++) {
    const before = hits.length;
    hits.push(...decodeQRRegion(work, width, height, max - hits.length));
    if (useTiles) {
      for (const y of ys) {
        for (const x of xs) {
          const part = decodeQRRegion(cropRaster(work, width, x, y, tileW, tileH), tileW, tileH, 4);
          for (const hit of part) {
            const rect = { ...hit.rect, x: hit.rect.x + x, y: hit.rect.y + y };
            hits.push({ ...hit, rect });
            paintWhite(work, width, height, rect);
          }
        }
      }
    }
    if (hits.length === before) break;
  }
  return dedupeHits(hits);
}

export async function decodeBarcodes(raster: Raster): Promise<CodeHit[] | null> {
  const loading = loadEngine();
  if (!loading) return null;
  let engine: typeof import("zxing-wasm/reader");
  try { engine = await loading; } catch { return null; }
  try {
    const results = await engine.readBarcodes(
      { data: raster.data, width: raster.width, height: raster.height, colorSpace: "srgb" } as ImageData,
      { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 12 },
    );
    return results.filter((r) => r.isValid).map((r) => {
      const p = r.position;
      const points = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
      const isQR = r.format === "QRCode" || r.format === "MicroQRCode" || r.format === "RMQRCode";
      return {
        kind: isQR ? "QR code" as const : "Barcode" as const,
        format: String(r.format),
        payload: r.text,
        rect: clampTo(boundsOf(points, padFor(points)), raster.width, raster.height),
      };
    });
  } catch {
    return null;
  }
}

/** Collapse repeats of the same code seen by different decoders, scales or tiles. */
export function dedupeHits(hits: CodeHit[]): CodeHit[] {
  const out: CodeHit[] = [];
  for (const hit of hits) {
    if (hit.rect.width < MIN_CODE_PX || hit.rect.height < MIN_CODE_PX) continue;
    const same = out.find((other) => overlap(hit.rect, other.rect) >= 0.5);
    if (same) {
      same.rect = unionRect(same.rect, hit.rect);
      if (!same.payload && hit.payload) same.payload = hit.payload;
      continue;
    }
    out.push({ ...hit });
  }
  return out;
}

// ---- browser entry point ----

function dimensions(source: Source) {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

function rasterOf(source: Source, crop: Rect, scale: number): Raster | null {
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff"; // transparent PNG areas should read as white, not black
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { data: image.data, width, height };
}

/**
 * Find every QR code and barcode in an image or rendered PDF page. Rectangles are returned in the
 * source's own pixel coordinates, ready to be used as redaction boxes.
 */
export async function scanCodes(source: Source, options: { isCancelled?: () => boolean } = {}): Promise<ScanResult> {
  const { width, height } = dimensions(source);
  const longest = Math.max(width, height);
  const plans: { crop: Rect; scale: number }[] = [{ crop: { x: 0, y: 0, width, height }, scale: Math.min(1, MAX_SIDE / longest) }];
  if (longest < SMALL_SIDE) plans.push({ crop: { x: 0, y: 0, width, height }, scale: Math.min(2, 2800 / longest) });
  if (longest > MAX_SIDE) {
    // Downscaling a big screenshot can shrink a small code below readability, so also look at native-size tiles.
    const step = TILE - TILE_OVERLAP;
    outer: for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (plans.length > MAX_TILES) break outer;
        plans.push({ crop: { x, y, width: Math.min(TILE, width - x), height: Math.min(TILE, height - y) }, scale: 1 });
        if (x + TILE >= width) break;
      }
      if (y + TILE >= height) break;
    }
  }

  const hits: CodeHit[] = [];
  let engineWorked = true;
  for (const plan of plans) {
    if (options.isCancelled?.()) break;
    const raster = rasterOf(source, plan.crop, plan.scale);
    if (!raster) continue;
    for (const hit of decodeQR(raster)) hits.push(transform(hit, plan.scale, plan.crop.x, plan.crop.y));
    const barcodes = await decodeBarcodes(raster);
    if (barcodes === null) engineWorked = false;
    else for (const hit of barcodes) hits.push(transform(hit, plan.scale, plan.crop.x, plan.crop.y));
  }
  return { hits: dedupeHits(hits), barcodeEngine: engineWorked ? "ready" : "unavailable" };
}

// ---- turning hits into reviewable detections ----

const MAX_TEXT = 90;

export function codeDetections(hits: CodeHit[]): Detection[] {
  return hits.map((hit, index) => {
    const payload = hit.payload.replace(/\s+/g, " ").trim() || "(binary data)";
    const label = hit.kind === "Barcode" ? `${hit.format}: ${payload}` : payload;
    return {
      id: `${hit.kind}-${index}-${Math.round(hit.rect.x)}-${Math.round(hit.rect.y)}`,
      category: hit.kind,
      text: label.length > MAX_TEXT ? `${label.slice(0, MAX_TEXT - 1)}…` : label,
      confidence: "Pattern match" as const,
      rect: hit.rect,
      selected: true,
    };
  });
}

/** Share of `inner`'s area that lies inside `outer`. */
function shareInside(inner: Rect, outer: Rect): number {
  const w = Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x));
  const h = Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
  const area = inner.width * inner.height;
  return area > 0 ? (w * h) / area : 0;
}

/**
 * Put codes first, and drop OCR detections that sit on top of a code (OCR reads the pattern as junk
 * text). A larger detection that merely touches a code is kept: only things inside the code's box go.
 */
export function mergeCodeDetections(textDetections: Detection[], codes: Detection[]): Detection[] {
  if (!codes.length) return textDetections;
  const kept = textDetections.filter((d) => !codes.some((c) => shareInside(d.rect, c.rect) >= 0.6));
  return [...codes, ...kept];
}
