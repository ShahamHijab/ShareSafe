"use client";

import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import { Header } from "@/components/Header";
import { DownloadIcon, LockIcon, PenIcon, RefreshIcon, UploadIcon } from "@/components/Icons";
import { detectPatterns, type OCRWord } from "@/lib/detectPatterns";
import { downloadBlob } from "@/lib/download";
import type { Detection, Rect } from "@/lib/types";

type PageData = {
  number: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  detections: Detection[];
};

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 40;
const categoryIcons: Record<string, string> = {
  Email: "@", "Pakistan phone": "☎", "Pakistan address": "⌂", CNIC: "ID",
  "IP address": "IP", URL: "↗", "Possible secret": "••",
};

export default function PdfPage() {
  const [fileName, setFileName] = useState("");
  const [pages, setPages] = useState<PageData[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [manualPage, setManualPage] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ page: number; rect: Rect } | null>(null);
  const [dragging, setDragging] = useState(false);
  const workerRef = useRef<{ terminate: () => Promise<unknown> } | null>(null);
  const generation = useRef(0);
  const origins = useRef<Record<number, { x: number; y: number }>>({});
  const canvases = useRef<Record<number, HTMLCanvasElement | null>>({});

  useEffect(() => () => {
    generation.current++;
    if (workerRef.current) void workerRef.current.terminate();
  }, []);

  async function loadPdf(file?: File) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file."); return;
    }
    if (file.size > MAX_BYTES) { setError("This PDF is over 40 MB. Choose a smaller file."); return; }
    const run = ++generation.current;
    if (workerRef.current) { await workerRef.current.terminate().catch(() => undefined); workerRef.current = null; }
    setFileName(file.name); setPages([]); setError(""); setBusy(true); setManualPage(null); setDone(false);
    setProgress("Opening your PDF…");
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfjsAny = pdfjs as any;
      pdfjsAny.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsAny.version}/pdf.worker.min.js`;
      const bytes = await file.arrayBuffer();
      const pdf = await pdfjsAny.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
      if (pdf.numPages > MAX_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages. The local editor supports up to ${MAX_PAGES}.`);
      const worker = await createWorker("eng", 1);
      workerRef.current = worker;
      const result: PageData[] = [];
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        if (run !== generation.current) { await worker.terminate(); return; }
        setProgress(`Scanning page ${pageNo} of ${pdf.numPages}…`);
        const page = await pdf.getPage(pageNo);
        const viewport = page.getViewport({ scale: Math.min(1.8, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1])) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not render a PDF page.");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
        const ocr = await worker.recognize(canvas);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const words: OCRWord[] = (ocr.data.words ?? []).filter((w: any) => w.text.trim()).map((w: any) => ({
          text: w.text.trim(), bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        }));
        const found = detectPatterns(words).map((d, i) => ({ ...d, id: `p${pageNo}-${i}-${d.id}`, selected: true }));
        result.push({ number: pageNo, width: canvas.width, height: canvas.height, canvas, detections: found });
      }
      await worker.terminate(); workerRef.current = null;
      if (run !== generation.current) return;
      setPages(result);
      const total = result.reduce((n, p) => n + p.detections.length, 0);
      setProgress(`Scan done — ${total} spot${total === 1 ? "" : "s"} flagged across ${result.length} page${result.length === 1 ? "" : "s"}.`);
    } catch (e) {
      if (run === generation.current) setError(e instanceof Error ? e.message : "Could not open this PDF.");
    } finally { if (run === generation.current) setBusy(false); }
  }

  function toggle(pageNo: number, id: string) {
    setDone(false);
    setPages((items) => items.map((p) => p.number !== pageNo ? p : ({ ...p, detections: p.detections.map((d) => d.id === id ? { ...d, selected: !d.selected } : d) })));
  }

  function localPoint(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const canvas = canvases.current[pageNo];
    if (!canvas) return null;
    const b = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - b.left) * canvas.width / b.width)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - b.top) * canvas.height / b.height)),
    };
  }
  function startDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    if (manualPage !== pageNo) return;
    const p = localPoint(e, pageNo); if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origins.current[pageNo] = p;
    setDraft({ page: pageNo, rect: { x: p.x, y: p.y, width: 0, height: 0 } });
  }
  function moveDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const o = origins.current[pageNo]; if (!o || manualPage !== pageNo) return;
    const p = localPoint(e, pageNo); if (!p) return;
    setDraft({ page: pageNo, rect: { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), width: Math.abs(p.x - o.x), height: Math.abs(p.y - o.y) } });
  }
  function finishDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const o = origins.current[pageNo]; if (!o || manualPage !== pageNo) return;
    const p = localPoint(e, pageNo); delete origins.current[pageNo];
    if (!p) { setDraft(null); return; }
    const rect = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), width: Math.abs(p.x - o.x), height: Math.abs(p.y - o.y) };
    setDraft(null);
    if (rect.width < 4 || rect.height < 4) return;
    setDone(false);
    setPages((items) => items.map((page) => page.number !== pageNo ? page : ({
      ...page,
      detections: [...page.detections, { id: `manual-${pageNo}-${Date.now()}`, category: "Possible secret", text: "Manual redaction", confidence: "Heuristic", rect, selected: true }],
    })));
    setManualPage(null);
  }

  async function exportPdf() {
    if (!pages.length || !pages.some((p) => p.detections.some((d) => d.selected))) return;
    setError("");
    try {
      const { PDFDocument } = await import("pdf-lib");
      // Fresh document: no source metadata, attachments, annotations, forms or text objects are copied.
      const out = await PDFDocument.create({ updateMetadata: false });
      for (const page of pages) {
        const canvas = document.createElement("canvas");
        canvas.width = page.width; canvas.height = page.height;
        const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not prepare page for export.");
        ctx.drawImage(page.canvas, 0, 0);
        ctx.fillStyle = "#000000";
        for (const d of page.detections) if (d.selected) ctx.fillRect(d.rect.x, d.rect.y, d.rect.width, d.rect.height);
        const png = await canvasToBytes(canvas);
        const embedded = await out.embedPng(png);
        const pdfPage = out.addPage([page.width, page.height]);
        pdfPage.drawImage(embedded, { x: 0, y: 0, width: page.width, height: page.height });
      }
      const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${fileName.replace(/\.pdf$/i, "") || "sharesafe"}-protected.pdf`);
      setDone(true);
      setProgress("Saved! Pages were flattened and rebuilt, so redactions can't be undone.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not export this PDF."); }
  }

  function reset() {
    generation.current++;
    if (workerRef.current) { void workerRef.current.terminate(); workerRef.current = null; }
    setPages([]); setFileName(""); setError(""); setProgress(""); setBusy(false); setManualPage(null); setDraft(null); setDone(false);
  }

  const totalSelected = pages.reduce((n, p) => n + p.detections.filter((d) => d.selected).length, 0);

  return (
    <main className="tool tool-pdf">
      <Header />
      <div className="tool-wrap">
        <div className="tool-title">
          <span className="tool-emoji">📄</span>
          <div><h1>PDF redaction</h1><p>Scan every page, pick what to hide, download a clean copy.</p></div>
          {(pages.length > 0 || busy) && <button className="btn btn-ghost" onClick={reset}><RefreshIcon /> Start over</button>}
        </div>

        {!pages.length ? (
          <div className={`dropzone ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) void loadPdf(e.dataTransfer.files?.[0]); }}>
            <div className="drop-icon">{busy ? <div className="spinner" /> : <UploadIcon />}</div>
            <h2>{busy ? "Reading your PDF…" : "Drop your PDF here"}</h2>
            <p>{busy ? progress : "Up to 40 MB · 40 pages"}</p>
            {busy ? <div className="progress-track"><div className="progress-indeterminate" /></div> : (
              <label className="btn btn-primary file-btn">Choose a PDF
                <input type="file" accept="application/pdf,.pdf" onChange={(e: ChangeEvent<HTMLInputElement>) => { void loadPdf(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            )}
            <span className="drop-note"><LockIcon /> Processed locally. Nothing is uploaded.</span>
            {error && <div className="alert alert-error" role="alert">{error}</div>}
          </div>
        ) : (
          <>
            <div className="card pdf-bar">
              <div><strong title={fileName}>{fileName}</strong><span>{pages.length} page{pages.length === 1 ? "" : "s"} · {totalSelected} to hide</span></div>
              <button className="btn btn-primary" onClick={() => void exportPdf()} disabled={totalSelected === 0}><DownloadIcon /> Download protected PDF</button>
            </div>
            {error && <div className="alert alert-error" role="alert">{error}</div>}
            {progress && <p className={`status ${done ? "status-ok" : ""}`} role="status">{progress}</p>}

            <div className="pdf-pages">
              {pages.map((page) => (
                <section className="card pdf-page-card" key={page.number}>
                  <div className="card-bar">
                    <h2>Page {page.number} <span className="badge">{page.detections.length} found</span></h2>
                    <button className={`btn ${manualPage === page.number ? "btn-on" : "btn-soft"}`} onClick={() => { setManualPage(manualPage === page.number ? null : page.number); setDraft(null); }}>
                      <PenIcon /> {manualPage === page.number ? "Drag on the page…" : "Draw a box"}
                    </button>
                  </div>
                  <div className={`pdf-canvas-stage ${manualPage === page.number ? "draw-mode" : ""}`}
                    onPointerDown={(e) => startDraw(e, page.number)} onPointerMove={(e) => moveDraw(e, page.number)}
                    onPointerUp={(e) => finishDraw(e, page.number)} onPointerCancel={(e) => finishDraw(e, page.number)}
                    style={{ touchAction: manualPage === page.number ? "none" : "auto" }}>
                    <canvas ref={(el) => { canvases.current[page.number] = el; if (el) { const c = el.getContext("2d"); if (c) c.drawImage(page.canvas, 0, 0); } }} width={page.width} height={page.height} />
                    {page.detections.map((d) => (
                      <button key={d.id} title={`${d.category}: ${d.text}`}
                        aria-label={`${d.selected ? "Selected" : "Unselected"} ${d.category} ${d.text}`}
                        onPointerDown={(e) => { if (manualPage === page.number) e.stopPropagation(); }}
                        onClick={() => { if (manualPage !== page.number) toggle(page.number, d.id); }}
                        className={`redaction-overlay ${d.selected ? "is-selected" : "is-unselected"}`}
                        style={{ left: `${d.rect.x / page.width * 100}%`, top: `${d.rect.y / page.height * 100}%`, width: `${d.rect.width / page.width * 100}%`, height: `${d.rect.height / page.height * 100}%`, pointerEvents: manualPage === page.number ? "none" : "auto" }} />
                    ))}
                    {draft?.page === page.number && <div className="redaction-overlay draft-overlay" style={{ left: `${draft.rect.x / page.width * 100}%`, top: `${draft.rect.y / page.height * 100}%`, width: `${draft.rect.width / page.width * 100}%`, height: `${draft.rect.height / page.height * 100}%` }} />}
                  </div>
                  {page.detections.length > 0 ? (
                    <div className="det-list det-list-flat">
                      {page.detections.map((d) => (
                        <button key={d.id} className={`det ${d.selected ? "on" : ""}`} onClick={() => toggle(page.number, d.id)}>
                          <span className="det-check">{d.selected ? "✓" : ""}</span>
                          <span className="det-icon">{categoryIcons[d.category]}</span>
                          <span className="det-copy"><strong>{d.category}</strong><span title={d.text}>{d.text}</span></span>
                        </button>
                      ))}
                    </div>
                  ) : <p className="fine pad">Nothing flagged on this page. Draw a box to cover anything yourself.</p>}
                </section>
              ))}
            </div>
            <p className="fine">Exported pages are flattened to images, so text won&apos;t be searchable. Detection can miss things — check every page.</p>
          </>
        )}
      </div>
    </main>
  );
}

function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
    if (!blob) { reject(new Error("Could not encode a PDF page.")); return; }
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, "image/png"));
}
