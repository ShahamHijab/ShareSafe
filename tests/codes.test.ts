import assert from "node:assert/strict";
import fs from "node:fs";
import { before, test } from "node:test";
import QRCode from "qrcode";
import { codeDetections, configureBarcodeEngine, decodeBarcodes, decodeQR, dedupeHits, mergeCodeDetections, type Raster } from "../lib/codeScan";
import type { Detection, Rect } from "../lib/types";

before(() => {
  configureBarcodeEngine({ wasmBinary: fs.readFileSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm") });
});

function blank(width: number, height: number): Raster {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}
function setPx(r: Raster, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const o = (y * r.width + x) * 4;
  const v = dark ? 0 : 255;
  r.data[o] = r.data[o + 1] = r.data[o + 2] = v;
  r.data[o + 3] = 255;
}

/** Draw a QR code; returns the rectangle of its modules (without the quiet zone). */
function drawQR(r: Raster, text: string, x0: number, y0: number, px: number, opts: { invert?: boolean; rotate?: number } = {}): Rect {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const size = n * px;
  const angle = opts.rotate ?? 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = x0 + size / 2, cy = y0 + size / 2;
  const quiet = 4 * px;
  const reach = Math.ceil((size + 2 * quiet) * 0.75);
  for (let y = Math.floor(cy - reach); y < cy + reach; y++) {
    for (let x = Math.floor(cx - reach); x < cx + reach; x++) {
      // inverse-rotate into the code's own frame
      const u = (x - cx) * cos + (y - cy) * sin + size / 2;
      const v = -(x - cx) * sin + (y - cy) * cos + size / 2;
      if (u < -quiet || v < -quiet || u >= size + quiet || v >= size + quiet) continue;
      const inside = u >= 0 && v >= 0 && u < size && v < size;
      let dark = inside ? qr.modules.get(Math.floor(v / px), Math.floor(u / px)) === 1 : false;
      if (opts.invert) dark = !dark;
      setPx(r, x, y, dark);
    }
  }
  if (angle === 0) return { x: x0, y: y0, width: size, height: size };
  const corners = [[0, 0], [size, 0], [size, size], [0, size]].map(([u, v]) => ({
    x: cx + (u - size / 2) * cos - (v - size / 2) * sin,
    y: cy + (u - size / 2) * sin + (v - size / 2) * cos,
  }));
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// EAN-13 encoder (standard L/G/R tables) so no extra barcode library is needed for tests.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
function ean13(d: string) {
  let bits = "101";
  for (let i = 0; i < 6; i++) bits += PARITY[+d[0]][i] === "L" ? L[+d[i + 1]] : G[+d[i + 1]];
  bits += "01010";
  for (let i = 0; i < 6; i++) bits += R[+d[i + 7]];
  return bits + "101";
}
function drawEAN(r: Raster, digits: string, x0: number, y0: number, moduleW = 3, height = 110): Rect {
  const bits = ean13(digits);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1") continue;
    for (let dx = 0; dx < moduleW; dx++) for (let y = 0; y < height; y++) setPx(r, x0 + i * moduleW + dx, y0 + y, true);
  }
  return { x: x0, y: y0, width: bits.length * moduleW, height };
}

function covers(outer: Rect, inner: Rect, tolerance = 1) {
  return outer.x <= inner.x + tolerance && outer.y <= inner.y + tolerance &&
    outer.x + outer.width >= inner.x + inner.width - tolerance && outer.y + outer.height >= inner.y + inner.height - tolerance;
}
function tooBig(outer: Rect, inner: Rect, factor = 1.5) {
  return outer.width * outer.height > inner.width * inner.height * factor;
}

test("QR: decodes payment link and the redaction box covers the whole code", () => {
  const img = blank(900, 700);
  const url = "https://pay.example.com/checkout?token=abc123secret";
  const truth = drawQR(img, url, 200, 150, 6);
  const hits = decodeQR(img);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].payload, url);
  assert.ok(covers(hits[0].rect, truth), `box ${JSON.stringify(hits[0].rect)} must cover ${JSON.stringify(truth)}`);
  assert.ok(!tooBig(hits[0].rect, truth), "box should not be wildly larger than the code");
});

test("QR: several codes in one image are all found", () => {
  const img = blank(1200, 800);
  const a = drawQR(img, "otpauth://totp/Bank:me@example.com?secret=JBSWY3DPEHPK3PXP", 60, 60, 5);
  const b = drawQR(img, "WIFI:T:WPA;S:HomeNet;P:hunter2hunter2;;", 600, 100, 5);
  const c = drawQR(img, "upi://pay?pa=someone@bank&am=500", 300, 450, 5);
  const hits = decodeQR(img);
  assert.equal(hits.length, 3);
  for (const truth of [a, b, c]) assert.ok(hits.some((h) => covers(h.rect, truth)), `no box covers ${JSON.stringify(truth)}`);
  assert.deepEqual(hits.map((h) => h.payload).sort(), [
    "WIFI:T:WPA;S:HomeNet;P:hunter2hunter2;;",
    "otpauth://totp/Bank:me@example.com?secret=JBSWY3DPEHPK3PXP",
    "upi://pay?pa=someone@bank&am=500",
  ].sort());
});

test("QR: dark-mode (inverted) and rotated codes", () => {
  const inverted = blank(700, 700);
  for (let i = 0; i < inverted.data.length; i += 4) inverted.data[i] = inverted.data[i + 1] = inverted.data[i + 2] = 0; // dark page
  const t1 = drawQR(inverted, "https://example.com/inverted", 200, 200, 6, { invert: true });
  const h1 = decodeQR(inverted);
  assert.equal(h1.length, 1);
  assert.ok(covers(h1[0].rect, t1));

  for (const degrees of [90, 20, 45]) {
    const img = blank(800, 800);
    const truth = drawQR(img, "https://example.com/rotated", 300, 300, 6, { rotate: (degrees * Math.PI) / 180 });
    const hits = decodeQR(img);
    assert.equal(hits.length, 1, `${degrees} degrees`);
    assert.ok(covers(hits[0].rect, truth, 3), `${degrees} degrees: box must cover the rotated code`);
  }
});

test("QR: input pixels are not modified by scanning", () => {
  const img = blank(600, 600);
  drawQR(img, "https://example.com/x", 150, 150, 6);
  const before = Uint8ClampedArray.from(img.data);
  decodeQR(img);
  assert.deepEqual(img.data, before);
});

test("QR: an image without codes finds nothing", () => {
  const img = blank(600, 400);
  for (let y = 100; y < 120; y++) for (let x = 50; x < 500; x++) setPx(img, x, y, (x >> 2) % 2 === 0); // stripes, not a code
  assert.equal(decodeQR(img).length, 0);
});

test("barcode: EAN-13 is decoded with an exact box (zxing-wasm)", async () => {
  const img = blank(700, 400);
  const truth = drawEAN(img, "5901234123457", 150, 120);
  const hits = await decodeBarcodes(img);
  assert.ok(hits, "engine should load");
  assert.equal(hits!.length, 1);
  assert.equal(hits![0].kind, "Barcode");
  assert.equal(hits![0].payload, "5901234123457");
  assert.ok(covers(hits![0].rect, truth), `box ${JSON.stringify(hits![0].rect)} must cover ${JSON.stringify(truth)}`);
  assert.ok(!tooBig(hits![0].rect, truth, 1.6));
});

test("barcode engine also reads QR (second opinion) and dedupe merges the repeat", async () => {
  const img = blank(800, 600);
  const truth = drawQR(img, "https://example.com/both", 250, 150, 6);
  const fromJsQR = decodeQR(img);
  const fromZxing = await decodeBarcodes(img);
  assert.ok(fromZxing && fromZxing.length === 1 && fromZxing[0].kind === "QR code");
  const merged = dedupeHits([...fromJsQR, ...fromZxing!]);
  assert.equal(merged.length, 1);
  assert.ok(covers(merged[0].rect, truth));
});

test("barcode engine failure is reported, not thrown", async () => {
  configureBarcodeEngine({ wasmBinary: new Uint8Array([0, 1, 2, 3]) }); // not a wasm module
  const result = await decodeBarcodes(blank(100, 100));
  assert.equal(result, null);
  configureBarcodeEngine({ wasmBinary: fs.readFileSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm") });
});

test("detections: codes are selected by default, show the payload, and replace OCR noise on top of them", () => {
  const hits = [
    { kind: "QR code" as const, format: "QR Code", payload: "https://pay.example.com/?t=1", rect: { x: 100, y: 100, width: 200, height: 200 } },
    { kind: "Barcode" as const, format: "EAN13", payload: "5901234123457", rect: { x: 400, y: 100, width: 285, height: 110 } },
  ];
  const codes = codeDetections(hits);
  assert.deepEqual(codes.map((d) => [d.category, d.selected, d.confidence]), [["QR code", true, "Pattern match"], ["Barcode", true, "Pattern match"]]);
  assert.equal(codes[0].text, "https://pay.example.com/?t=1");
  assert.equal(codes[1].text, "EAN13: 5901234123457");

  const junkOnQR: Detection = { id: "j", category: "High-entropy string", text: "x", confidence: "Heuristic", rect: { x: 120, y: 120, width: 60, height: 12 }, selected: true };
  const largeTouching: Detection = { id: "a", category: "Pakistan address", text: "addr", confidence: "Heuristic", rect: { x: 250, y: 150, width: 150, height: 60 }, selected: true };
  const elsewhere: Detection = { id: "e", category: "Email", text: "a@b.co", confidence: "Pattern match", rect: { x: 0, y: 500, width: 100, height: 20 }, selected: true };
  const merged = mergeCodeDetections([junkOnQR, largeTouching, elsewhere], codes);
  assert.deepEqual(merged.map((d) => d.id), [codes[0].id, codes[1].id, "a", "e"]);

  const long = codeDetections([{ ...hits[0], payload: "x".repeat(500) }])[0];
  assert.ok(long.text.length <= 90);
});
