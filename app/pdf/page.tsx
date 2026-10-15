 "use client";

import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import { detectPatterns, type OCRWord } from "@/lib/detectPatterns";
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
  const [manualPage, setManualPage] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ page: number; rect: Rect } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [metadataNote, setMetadataNote] = useState("PDF export rebuilds each page from flattened pixels. This removes original document metadata and non-visible PDF objects; review the output before sharing.");
  const workerRef = useRef<{ terminate: () => Promise<unknown> } | null>(null);
  const generation = useRef(0);
  const origins = useRef<Record<number, {x:number;y:number}>>({});
  const canvases = useRef<Record<number, HTMLCanvasElement | null>>({});

  useEffect(() => () => {
    generation.current++;
    if (workerRef.current) void workerRef.current.terminate();
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  function clearDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl("");
    setDownloadName("");
  }

  async function loadPdf(file?: File) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file."); return;
    }
    if (file.size > MAX_BYTES) { setError("This PDF is over 40 MB. Choose a smaller file."); return; }
    const run = ++generation.current;
    if (workerRef.current) { await workerRef.current.terminate().catch(() => undefined); workerRef.current = null; }
    clearDownload();
    setFileName(file.name); setPages([]); setError(""); setBusy(true); setManualPage(null);
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
      const pdfjsAny = pdfjs as any;
      // The legacy build is used for broad browser compatibility; the worker is loaded from the matching package version.
      pdfjsAny.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsAny.version}/pdf.worker.min.js`;
      const bytes = await file.arrayBuffer();
      const pdf = await pdfjsAny.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
      if (pdf.numPages > MAX_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages. The local editor supports up to ${MAX_PAGES} pages at a time.`);
      const worker = await createWorker("eng", 1, { logger: (info) => { if (info.status) setProgress(info.status); } });
      workerRef.current = worker;
      const result: PageData[] = [];
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        if (run !== generation.current) { await worker.terminate(); return; }
        setProgress(`Rendering and scanning page ${pageNo} of ${pdf.numPages}…`);
        const page = await pdf.getPage(pageNo);
        const viewport = page.getViewport({ scale: Math.min(1.8, 2400 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1])) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not render a PDF page.");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0,0,canvas.width,canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
        const ocr = await worker.recognize(canvas);
        const words: OCRWord[] = (ocr.data.words ?? []).filter((w: any) => w.text.trim()).map((w: any) => ({
          text: w.text.trim(), bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        }));
        const found = detectPatterns(words).map((d, i) => ({ ...d, id: `p${pageNo}-${i}-${d.id}`, selected: true }));
        result.push({ number: pageNo, width: canvas.width, height: canvas.height, canvas, detections: found });
        setProgress(`Scanned page ${pageNo} of ${pdf.numPages}…`);
      }
      await worker.terminate(); workerRef.current = null;
      if (run !== generation.current) return;
      setPages(result);
      setMetadataNote("Export reconstructs pages as images in a new PDF. It removes original metadata, embedded files, scripts, forms, annotations, hidden layers, and selectable source text from the output. It also means exported pages are rasterized, not searchable text.");
      setProgress(`Scan complete. ${result.reduce((n,p)=>n+p.detections.length,0)} suggested redactions across ${result.length} page(s).`);
    } catch (e) {
      if (run === generation.current) setError(e instanceof Error ? e.message : "Could not open this PDF.");
    } finally { if (run === generation.current) setBusy(false); }
  }

  function updateDetection(pageNo: number, id: string, action: "toggle" | "delete") {
    clearDownload();
    setPages(items => items.map(p => p.number !== pageNo ? p : ({ ...p, detections: action === "delete" ? p.detections.filter(d => d.id !== id) : p.detections.map(d => d.id === id ? { ...d, selected: !d.selected } : d) })));
  }

  function localPoint(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const canvas = canvases.current[pageNo];
    if (!canvas) return null;
    const b = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (e.clientX-b.left)*canvas.width/b.width)), y: Math.max(0, Math.min(canvas.height, (e.clientY-b.top)*canvas.height/b.height)) };
  }
  function startDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    if (manualPage !== pageNo) return;
    const p = localPoint(e,pageNo); if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId); origins.current[pageNo] = p; setDraft({ page: pageNo, rect: {x:p.x,y:p.y,width:0,height:0} });
  }
  function moveDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const o = origins.current[pageNo]; if (!o || manualPage !== pageNo) return;
    const p = localPoint(e,pageNo); if (!p) return;
    setDraft({ page: pageNo, rect: {x:Math.min(o.x,p.x),y:Math.min(o.y,p.y),width:Math.abs(p.x-o.x),height:Math.abs(p.y-o.y)} });
  }
  function finishDraw(e: PointerEvent<HTMLDivElement>, pageNo: number) {
    const o = origins.current[pageNo]; if (!o || manualPage !== pageNo) return;
    const p = localPoint(e,pageNo); delete origins.current[pageNo]; if (!p) { setDraft(null); return; }
    const rect = {x:Math.min(o.x,p.x),y:Math.min(o.y,p.y),width:Math.abs(p.x-o.x),height:Math.abs(p.y-o.y)};
    setDraft(null); if (rect.width < 4 || rect.height < 4) return;
    clearDownload();
    setPages(items => items.map(page => page.number !== pageNo ? page : ({...page,detections:[...page.detections,{id:`manual-${pageNo}-${Date.now()}`,category:"Possible secret",text:"Manual redaction",confidence:"Heuristic",rect,selected:true}]})));
    setManualPage(null);
  }

  async function exportPdf() {
    if (!pages.length || !pages.some(p => p.detections.some(d => d.selected))) return;
    setError(""); clearDownload();
    try {
      const { PDFDocument } = await import("pdf-lib");
      const out = await PDFDocument.create({ updateMetadata: false });
      // Do not copy any source catalog, metadata, attachments, annotations, or form objects.
      // The new document contains only page image XObjects and the minimum PDF structure needed to display them.
      for (const page of pages) {
        const canvas = document.createElement("canvas");
        canvas.width = page.width; canvas.height = page.height;
        const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not prepare page for export.");
        ctx.drawImage(page.canvas,0,0);
        for (const d of page.detections) if (d.selected) {
          ctx.fillStyle = "#000000"; ctx.fillRect(d.rect.x,d.rect.y,d.rect.width,d.rect.height);
        }
        const png = await canvasToBytes(canvas);
        const embedded = await out.embedPng(png);
        const pdfPage = out.addPage([page.width,page.height]);
        pdfPage.drawImage(embedded,{x:0,y:0,width:page.width,height:page.height});
      }
      const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
      const blob = new Blob([bytes as BlobPart],{type:"application/pdf"});
      const url = URL.createObjectURL(blob); setDownloadUrl(url);
      setDownloadName(`${fileName.replace(/\.pdf$/i,"") || "sharesafe"}-protected.pdf`);
      setProgress("Protected PDF created. Redactions are burned into page pixels and the PDF was rebuilt from scratch.");
    } catch(e) { setError(e instanceof Error ? e.message : "Could not export this PDF."); }
  }

  function reset() {
    generation.current++; if (workerRef.current) { void workerRef.current.terminate(); workerRef.current = null; }
    clearDownload(); setPages([]); setFileName(""); setError(""); setProgress(""); setBusy(false); setManualPage(null); setDraft(null);
  }

  const totalSelected = pages.reduce((n,p)=>n+p.detections.filter(d=>d.selected).length,0);
  return <main className="pdf-page">
    <header className="site-header"><a className="brand" href="/"><span className="brand-mark"><PdfShieldIcon /></span><span>ShareSafe</span></a><nav className="header-nav"><a href="/">Image redaction</a><a href="/#privacy">Privacy</a></nav><a className="button button-small" href="/">Image tool ↗</a></header>
    <section className="pdf-hero"><div className="eyebrow"><span className="eyebrow-dot" /> LOCAL PDF PROTECTION</div><h1>Redact PDFs.<br/><span>Strip the hidden details.</span></h1><p>Scan for sensitive text, review every match, draw your own redactions, and rebuild a clean PDF with metadata and hidden objects removed.</p><div className="hero-note"><PdfLockIcon/> Files are processed in your browser. Nothing is uploaded.</div></section>
    <section className="workspace-section pdf-workspace">
      <div className="section-heading"><div><div className="eyebrow">PDF WORKSPACE</div><h2>Review every page.</h2><p>Automatic suggestions are a starting point. Always inspect every page before sharing.</p></div>{pages.length>0 && <button className="button button-quiet" onClick={reset}>Start over</button>}</div>
      {!pages.length ? <div className="upload-card">
        <div className="upload-icon"><PdfFileIcon/></div><h3>{busy ? "Reading your PDF…" : "Choose a PDF to protect"}</h3><p>{busy ? progress : "Text recognition and rendering happen locally in this browser."}</p>
        <label className="button upload-button">{busy ? "Processing…" : "Choose a PDF"}<input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(e:ChangeEvent<HTMLInputElement>)=>{void loadPdf(e.target.files?.[0]);e.target.value="";}}/></label>
        <div className="file-hint">PDF <span>·</span> Up to 40 MB <span>·</span> 40 pages maximum</div><div className="privacy-inline"><PdfLockIcon/> OCR is English-only. Text may be missed; scanned pages are supported through OCR.</div>
        {busy && <div className="progress-track pdf-progress"><div className="progress-indeterminate"/></div>}{error && <div className="alert alert-error" role="alert">{error}</div>}
      </div> : <>
        <div className="pdf-toolbar"><div><strong>{fileName}</strong><span>{pages.length} pages · {totalSelected} selected redactions</span></div><button className="button export-button" onClick={()=>void exportPdf()} disabled={totalSelected===0}>Create protected PDF ↗</button></div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="pdf-pages">{pages.map(page=><section className="pdf-page-card" key={page.number}>
          <div className="pdf-page-heading"><div><span className="panel-kicker">PAGE {page.number}</span><strong>{page.detections.length} suggestions</strong></div><button className={`button button-secondary ${manualPage===page.number?"button-active":""}`} onClick={()=>setManualPage(manualPage===page.number?null:page.number)}>{manualPage===page.number?"Cancel drawing":"Draw redaction"}</button></div>
          <div className={`pdf-canvas-stage ${manualPage===page.number?"draw-mode":""}`} onPointerDown={e=>startDraw(e,page.number)} onPointerMove={e=>moveDraw(e,page.number)} onPointerUp={e=>finishDraw(e,page.number)} onPointerCancel={e=>finishDraw(e,page.number)} style={{touchAction:manualPage===page.number?"none":"auto"}}>
            <canvas ref={el=>{canvases.current[page.number]=el;if(el){const c=el.getContext("2d");if(c)c.drawImage(page.canvas,0,0);}}} width={page.width} height={page.height}/>
            {page.detections.map(d=><button key={d.id} title={`${d.category}: ${d.text}`} aria-label={`${d.selected?"Selected":"Unselected"} ${d.category} ${d.text}`} onPointerDown={e=>{if(manualPage===page.number)e.stopPropagation();}} onClick={()=>{if(manualPage!==page.number)updateDetection(page.number,d.id,"toggle");}} className={`redaction-overlay ${d.selected?"is-selected":"is-unselected"}`} style={{left:`${d.rect.x/page.width*100}%`,top:`${d.rect.y/page.height*100}%`,width:`${d.rect.width/page.width*100}%`,height:`${d.rect.height/page.height*100}%`,pointerEvents:manualPage===page.number?"none":"auto"}}/>)}
            {draft?.page===page.number && <div className="redaction-overlay draft-overlay" style={{left:`${draft.rect.x/page.width*100}%`,top:`${draft.rect.y/page.height*100}%`,width:`${draft.rect.width/page.width*100}%`,height:`${draft.rect.height/page.height*100}%`}}/>}
          </div>
          {page.detections.length>0 && <div className="pdf-detection-list">{page.detections.map(d=><div className={`detection-item ${d.selected?"chosen":""}`} key={d.id}><label className="detection-check"><input type="checkbox" checked={d.selected} onChange={()=>updateDetection(page.number,d.id,"toggle")}/><span className="custom-check">✓</span></label><span className="category-icon">{categoryIcons[d.category]}</span><button className="detection-copy" onClick={()=>updateDetection(page.number,d.id,"toggle")}><strong>{d.category}</strong><span>{d.text}</span><small>{d.confidence}</small></button><button className="delete-detection" onClick={()=>updateDetection(page.number,d.id,"delete")} aria-label="Remove redaction">×</button></div>)}</div>}
          {page.detections.length===0 && <p className="pdf-no-matches">No patterns detected on this page. Use Draw redaction to cover details manually.</p>}
        </section>)}</div>
        <section className="panel export-panel pdf-export-panel"><div className="panel-header"><div><span className="panel-kicker">PROTECTED COPY</span><h3>Export a sanitized PDF</h3></div><span className="export-icon"><PdfShieldIcon/></span></div><p>Pages are rasterized into a new PDF and selected redactions are permanently burned in.</p><button className="button export-button" onClick={()=>void exportPdf()} disabled={totalSelected===0}>Create protected PDF ↗</button>{downloadUrl && <a className="button download-button" href={downloadUrl} download={downloadName}>Download {downloadName}</a>}<div className="metadata-note"><div className="metadata-title"><PdfShieldIcon/> Metadata and hidden content</div><p>{metadataNote}</p><p><strong>Important:</strong> Rasterization removes searchable text, links and accessibility structure. Review the exported file in a PDF viewer and do not share the original.</p></div></section>
      </>}
      {progress && pages.length>0 && <div className="status-message"><span className="status-dot"/>{progress}</div>}
    </section>
    <section className="privacy-section"><div className="privacy-emblem"><PdfLockIcon/></div><div><div className="eyebrow">PRIVATE BY DESIGN</div><h2>Redact, then rebuild.</h2><p>ShareSafe processes PDF bytes, page rendering and OCR in your browser. It does not upload your document. The exported PDF is rebuilt from visible page pixels, rather than editing the original PDF objects.</p></div><div className="privacy-points"><span>✓ No cloud upload</span><span>✓ Manual and suggested redactions</span><span>✓ Rebuilt PDF without source metadata</span></div></section>
    <footer className="site-footer"><a className="brand footer-brand" href="/"><span className="brand-mark"><PdfShieldIcon/></span><span>ShareSafe</span></a><span>Make sharing a little safer.</span><p>Detection is not comprehensive. Verify every page and every redaction.</p></footer>
  </main>;
}

function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve,reject)=>canvas.toBlob(async blob=>{if(!blob){reject(new Error("Could not encode a PDF page."));return;}resolve(new Uint8Array(await blob.arrayBuffer()));},"image/png"));
}
function PdfShieldIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z"/><path d="M8 12h8M12 8v8"/></svg>;}
function PdfFileIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M8.5 13h7M8.5 16h7"/></svg>;}
function PdfLockIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10" width="15" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>;}
