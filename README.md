# ShareSafe

A local-first screenshot redaction website built with Next.js, TypeScript, React, Tesseract.js, and the HTML Canvas API.

## Features

- Three pages: a chooser at `/`, image redaction at `/image`, PDF redaction at `/pdf`.
- Light and dark mode (follows your system by default; toggle in the header, remembered in this browser).
- PNG/JPG/JPEG image redaction (15 MB limit; also limits images to 60 megapixels / 12,000 px per side).
- PDF redaction at `/pdf`: up to 40 MB and 40 pages, local page rendering and English OCR, the same sensitive-pattern checks, review/toggle/delete suggestions, manual redaction boxes, and protected PDF export.
- PDF export rebuilds a fresh PDF from flattened page images, burning selected redactions into pixels and excluding source metadata, attachments, scripts, forms, annotations, hidden layers, and source text objects.
- English OCR using Tesseract.js in the browser with progress feedback and reset/cancel.
- Pattern checks for email, Pakistani mobile and common landline formats, likely Pakistani address blocks, CNIC formats, IPv4 addresses, URLs, and common secret/token patterns.
- Select, deselect, or remove suggested redactions; draw manual rectangle redactions.
- New PNG output rendered at the original image dimensions with selected rectangles painted as opaque black pixels.
- No accounts, backend, image upload endpoint, database, analytics, or persistence of image/OCR content.
- Honest metadata note: export re-encodes the pixels as PNG and does not copy source metadata through this canvas path; metadata stripping is expected, not independently verified.

## Requirements

- Node.js 18.17+ (Node 20 LTS recommended)
- npm
- Internet access on first install. Tesseract.js may also fetch its JavaScript worker and English language data on first OCR use. The image and recognized text are not sent with those asset requests.

## Setup — Windows PowerShell

Open PowerShell in the extracted `sharesafe` project folder, then run:

```powershell
node --version
npm --version
npm install
npm run dev
```

Open `http://localhost:3000`.

Production build and run:

```powershell
npm run typecheck
npm run build
npm run start
```

The development server can be stopped with `Ctrl+C`.

## Usage

1. On the home page choose **Image**, then select or drop a PNG, JPG, or JPEG image (up to 15 MB).
2. Wait for the English OCR scan to finish. OCR happens in the browser.
3. Review suggested regions. Checked suggestions are selected for redaction; click a suggestion or checkbox to toggle it. Remove an item with the × button.
4. Select **Draw a redaction**, then drag over any region to cover manually. Drawn boxes are added to the review list.
5. Create the protected PNG and download it. Reopen the exported PNG to verify the selected regions are covered.
6. Use **Start over** to clear the image and in-memory results.

## PDF redaction

1. Choose **PDF** on the home page or visit `/pdf`.
2. Select a PDF (up to 40 MB and 40 pages). Pages are rendered and English OCR runs locally in the browser. The matching PDF.js worker may be fetched from a CDN; document bytes and OCR text are not sent with that request.
3. Review suggestions page by page. Toggle or remove detections, or use **Draw redaction** to add manual boxes.
4. Create and download the protected PDF. The exporter creates a new PDF and embeds each page as a raster image with selected black boxes already burned in. This is designed to remove source metadata and non-visible PDF objects, not just edit the document info dictionary.

**Trade-off:** exported pages are rasterized and therefore lose searchable/selectable text, links, form fields, annotations, accessibility structure and vector quality. Detection is English-only and can miss details. Review every page and test the output in a separate PDF viewer before sharing. The source PDF is not modified.

## Architecture

- `app/page.tsx` — home page where you choose Image or PDF.
- `app/image/page.tsx` — image redaction experience.
- `app/pdf/page.tsx` — PDF page rendering, local OCR, review UI, manual drawing, flattened PDF export.
- `components/` — shared header, theme toggle and icons.
- `lib/download.ts` — one-click blob download helper.
- `app/globals.css` — light/dark theme tokens and all styles.
- `app/layout.tsx` — root layout and page metadata.
- `lib/detectPatterns.ts` — deterministic OCR-word text matching and union of word bounding boxes.
- `lib/imageExport.ts` — canvas-based opaque pixel redaction and PNG encoding.
- `lib/types.ts` — shared TypeScript types.

## Privacy and security model

- Source image bytes are loaded with a browser object URL and are processed in the browser. There is no application backend or upload endpoint.
- OCR text is kept in component memory only; it is not stored in localStorage, cookies, a database, or a server.
- Tesseract.js worker/language assets may be fetched from its configured package asset source, especially on first use. Those requests load OCR code/data, not the image or OCR text.
- Export draws the original pixels to a fresh canvas, then paints selected rectangles as opaque black pixels, and encodes that canvas to a new PNG blob. The exported file is not the original file.
- Canvas re-encoding generally omits source PNG/JPEG metadata, but this project does not independently inspect the generated file for metadata. Do not treat this as a universal metadata sanitizer.
- A screenshot of the editor or the unredacted source can still reveal sensitive information. Only share the downloaded protected PNG after reviewing it.

## Detection limitations

- Regex detection operates on OCR-recognized English text and can miss text because of image quality, font, rotation, low contrast, or OCR mistakes.
- Pakistani phone matching covers common mobile formats (03xx, +92/0092 3xx, with optional spaces/dashes/brackets) and several common landline area codes. It can still miss unusual extensions, OCR errors, or less common formatting.
- Secret matches are heuristics, not a credential scanner. They may miss secrets or flag harmless text.
- IPv4 matches are range-validated by octet.
- Multiword or punctuation-heavy detections may have approximate boxes because OCR words are joined with spaces for matching; a union box can include adjacent words. Inspect the overlay and add a manual box where needed.
- Address detection is a conservative local heuristic, not named-entity recognition. Explicit address labels (such as “Address in Pakistan”) are used to detect the value after the label; unlabeled addresses require stronger house/street/locality cues and usually a number. City names and administrative terms such as Faisalabad, Lahore, Karachi, tehsil, or district do not trigger redaction on their own. Detection is line-based to avoid combining nearby document headings and paragraphs into large redaction regions. It can still miss unfamiliar, Urdu-only, or badly OCR’d addresses, so review suggestions and manually draw a box for anything missed.
- Detection is a review aid, not a guarantee that an image is safe to share.

## Testing checklist

- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Drop and select valid PNG and JPEG files.
- [ ] Confirm unsupported types and files over 15 MB show an error.
- [ ] Confirm large pixel dimensions are rejected.
- [ ] Scan a test screenshot containing a sample email, Pakistani mobile/landline numbers in varied formats, a Pakistani address, CNIC-like value, IPv4, URL, and labelled secret.
- [ ] Toggle a suggested region and verify the overlay/list state remains in sync.
- [ ] Draw a manual box and check the exported PNG.
- [ ] Export, open the PNG in another viewer, and confirm black rectangles are permanent.
- [ ] Verify unchecked detections are not painted in the export.
- [ ] Reset during scan and after export; confirm the image/results clear.
- [ ] Check the UI at desktop and mobile widths.
- [ ] Inspect image export metadata independently if metadata guarantees are important.
- [ ] Test PDFs with selectable text and scanned pages, multi-page documents, manual boxes, and toggled detections.
- [ ] Inspect exported PDF metadata and confirm redactions cannot be removed or revealed. Confirm the expected rasterization trade-offs.

## Troubleshooting

- **OCR does not start / language data fails:** check the network connection and browser console. Tesseract.js may need to download its worker and English language data.
- **Scan is slow:** use a smaller screenshot; very large images are rejected to reduce memory pressure.
- **No matches appear:** OCR or regex may not recognize the text. Use the manual rectangle tool.
- **Redaction misses part of a phrase:** the union of OCR word boxes can be approximate. Draw a larger manual rectangle.
- **Export button disabled:** at least one redaction must be selected. Add a manual box or select a suggestion.
- **Port 3000 is busy:** Next.js normally offers another port in the terminal.

## Incomplete / future work

- No local named-entity recognition for names or addresses.
- No moving/resizing existing rectangles; delete and redraw a manual rectangle if placement needs correction.
- No automated unit or browser end-to-end tests are included.
- Metadata removal has not been independently verified.
- No Urdu OCR, batch file processing, extension, accounts, cloud storage, or deployment configuration.

### Screenshot OCR improvements

The scanner now preprocesses images locally (upscaling and gentle contrast enhancement) and performs two English OCR passes: the normal layout pass and Tesseract's sparse-text mode, which is better suited to chat bubbles and text scattered around screenshots. Word boxes are mapped back to the original image before detections are drawn. CNIC matching also tolerates OCR-inserted spaces, dots, parentheses, and hyphens. This improves coverage but cannot guarantee detection when text is blurry, tiny, obscured, or recognized incorrectly; always review the image and use manual redaction for missed details.
