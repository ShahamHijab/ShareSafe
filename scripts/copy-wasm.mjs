// Copies the barcode decoder's WebAssembly file into public/ so the browser loads it from this
// site instead of a CDN. Runs after `npm install` and before `dev` / `build` / `start`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm");
const target = join(root, "public", "zxing_reader.wasm");

if (!existsSync(source)) {
  console.warn("copy-wasm: zxing-wasm is not installed yet; skipping (barcodes need public/zxing_reader.wasm).");
} else {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log("copy-wasm: public/zxing_reader.wasm is ready");
}
