"use client";

import { ChangeEvent, DragEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import { detectPatterns, type OCRWord } from "@/lib/detectPatterns";
import { renderRedactedPNG } from "@/lib/imageExport";
import type { Detection, Rect } from "@/lib/types";

const MAX_BYTES = 15 * 1024 * 1024;
const categoryIcons: Record<string, string> = {
  Email: "@",
  "Pakistan phone": "☎",
  "Pakistan address": "⌂",
  CNIC: "ID",
  "IP address": "IP",
  URL: "↗",
  "Possible secret": "••",
};

export default function HomePage() {
  const [fileName, setFileName] = useState("");
  const [imageSrc, setImageSrc] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error" | "exported">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [exportUrl, setExportUrl] = useState("");
  const [exportName, setExportName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sourceUrlRef = useRef("");
  const exportUrlRef = useRef("");
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const activeWorker = useRef<{ terminate: () => Promise<unknown> } | null>(null);
  const scanGeneration = useRef(0);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
    if (activeWorker.current) void activeWorker.current.terminate();
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !imageSrc) {
      setPreviewSize({ width: 0, height: 0 });
      return;
    }
    const measure = () => {
      const bounds = image.getBoundingClientRect();
      setPreviewSize({ width: bounds.width, height: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    return () => observer.disconnect();
  }, [imageSrc]);

  function clearExport() {
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
    exportUrlRef.current = "";
    setExportUrl("");
    setExportName("");
  }

  async function loadFile(file?: File) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setStatus("error");
      setMessage("Choose a PNG, JPG, or JPEG image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus("error");
      setMessage("This image is over 15 MB. Choose a smaller file.");
      return;
    }
    const generation = ++scanGeneration.current;
    if (activeWorker.current) {
      await activeWorker.current.terminate().catch(() => undefined);
      activeWorker.current = null;
    }
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    clearExport();
    setFileName(file.name);
    setDetections([]);
    setDraft(null);
    setManualMode(false);
    setProgress(0);
    setMessage("Preparing local OCR…");
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    setImageSrc(url);
    setStatus("loading");
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (generation !== scanGeneration.current) return;
      if (image.naturalWidth > 12000 || image.naturalHeight > 12000 || image.naturalWidth * image.naturalHeight > 60_000_000) {
        throw new Error("This image has very large dimensions. Choose an image under 60 megapixels.");
      }
      const worker = await createWorker("eng", 1, {
        logger: (info) => {
          if (typeof info.progress === "number") setProgress(Math.round(info.progress * 100));
          if (info.status) setMessage(info.status);
        },
      });
      if (generation !== scanGeneration.current) {
        await worker.terminate();
        return;
      }
      activeWorker.current = worker;
      // WhatsApp and other chat screenshots often have small, anti-aliased text.
      // Upscale and improve contrast for OCR, while keeping coordinates mapped to the original image.
      const scale = Math.min(2.4, 5000 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not prepare this image for text recognition.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const gray = 0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2];
        // Gentle contrast stretch; avoid turning light WhatsApp bubbles into solid black.
        const enhanced = Math.max(0, Math.min(255, (gray - 128) * 1.18 + 128));
        pixels.data[i] = enhanced;
        pixels.data[i + 1] = enhanced;
        pixels.data[i + 2] = enhanced;
      }
      context.putImageData(pixels, 0, 0);

      const firstPass = await worker.recognize(canvas);
      if (generation !== scanGeneration.current) {
        if (activeWorker.current === worker) activeWorker.current = null;
        await worker.terminate();
        return;
      }
      // Sparse-text mode is better for chat bubbles, captions and text scattered around screenshots.
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      const secondPass = await worker.recognize(canvas);
      if (generation !== scanGeneration.current) {
        if (activeWorker.current === worker) activeWorker.current = null;
        await worker.terminate();
        return;
      }
      if (activeWorker.current === worker) activeWorker.current = null;
      await worker.terminate();

      // Keep OCR passes separate. Combining their words into one text stream can
      // accidentally join unrelated words from different passes and create huge
      // or nonsensical redaction boxes.
      const toOCRWords = (input: typeof firstPass.data.words): OCRWord[] =>
        (input ?? []).filter((word) => word.text.trim()).map((word) => ({
          text: word.text.trim(),
          bbox: {
            x0: word.bbox.x0 / scale, y0: word.bbox.y0 / scale,
            x1: word.bbox.x1 / scale, y1: word.bbox.y1 / scale,
          },
        }));
      const primaryWords = toOCRWords(firstPass.data.words);
      const sparseWords = toOCRWords(secondPass.data.words);
      const primaryDetections = detectPatterns(primaryWords);
      const sparseDetections = detectPatterns(sparseWords);

      // The normal OCR pass is the source of truth for heuristic categories
      // (especially addresses). Let sparse OCR supplement only explicit pattern
      // matches such as phone numbers, CNICs, emails, and URLs.
      const supplemental = sparseDetections.filter((candidate) =>
        candidate.confidence === "Pattern match" &&
        !primaryDetections.some((existing) => {
          if (existing.category !== candidate.category) return false;
          const a = existing.rect;
          const b = candidate.rect;
          const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
          const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
          const intersection = intersectionWidth * intersectionHeight;
          const smallerArea = Math.min(a.width * a.height, b.width * b.height);
          const sameText = existing.text.replace(/\D/g, "") === candidate.text.replace(/\D/g, "") &&
            existing.text.replace(/\D/g, "").length >= 7;
          return sameText || (smallerArea > 0 && intersection / smallerArea >= 0.55);
        })
      );
      const finalDetections = [...primaryDetections, ...supplemental];
      const wordCount = Math.max(primaryWords.length, sparseWords.length);
      setDetections(finalDetections);
      setStatus("ready");
      setMessage(wordCount ? `Scan complete. ${wordCount} OCR words reviewed using two screenshot-friendly passes.` : "No readable English text was found. Try a clearer/larger screenshot, or draw redaction boxes manually.");
    } catch (error) {
      if (generation !== scanGeneration.current) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not scan this image. Try another PNG or JPEG.");
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files?.[0]);
  }

  function toggleDetection(id: string) {
    clearExport();
    setDetections((items) => items.map((item) => item.id === id ? { ...item, selected: !item.selected } : item));
  }

  function deleteDetection(id: string) {
    clearExport();
    setDetections((items) => items.filter((item) => item.id !== id));
  }

  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    const bounds = image?.getBoundingClientRect();
    if (!image || !bounds || !bounds.width || !bounds.height) return null;
    const x = Math.max(0, Math.min(image.naturalWidth, (event.clientX - bounds.left) * image.naturalWidth / bounds.width));
    const y = Math.max(0, Math.min(image.naturalHeight, (event.clientY - bounds.top) * image.naturalHeight / bounds.height));
    return { x, y };
  }

  function startDraw(event: PointerEvent<HTMLDivElement>) {
    if (!manualMode || !imageSrc) return;
    const position = pointerPosition(event);
    if (!position) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = position;
    setDraft({ x: position.x, y: position.y, width: 0, height: 0 });
  }

  function moveDraw(event: PointerEvent<HTMLDivElement>) {
    if (!manualMode || !dragOrigin.current) return;
    const position = pointerPosition(event);
    if (!position) return;
    const origin = dragOrigin.current;
    setDraft({ x: Math.min(origin.x, position.x), y: Math.min(origin.y, position.y), width: Math.abs(position.x - origin.x), height: Math.abs(position.y - origin.y) });
  }

  function finishDraw(event: PointerEvent<HTMLDivElement>) {
    if (!manualMode || !dragOrigin.current) return;
    const position = pointerPosition(event);
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    if (!position) { setDraft(null); return; }
    const rect = { x: Math.min(origin.x, position.x), y: Math.min(origin.y, position.y), width: Math.abs(position.x - origin.x), height: Math.abs(position.y - origin.y) };
    setDraft(null);
    if (rect.width < 4 || rect.height < 4) return;
    clearExport();
    setDetections((items) => [...items, {
      id: `manual-${Date.now()}`,
      category: "Possible secret",
      text: "Manual redaction",
      confidence: "Heuristic",
      rect,
      selected: true,
    }]);
    setManualMode(false);
    setMessage("Manual redaction added. It will be burned into the exported PNG.");
  }

  async function exportImage() {
    const image = imageRef.current;
    if (!image || !image.complete) return;
    try {
      clearExport();
      const blob = await renderRedactedPNG(image, detections);
      const url = URL.createObjectURL(blob);
      exportUrlRef.current = url;
      setExportUrl(url);
      setExportName(`${fileName.replace(/\.[^.]+$/, "") || "sharesafe"}-protected.png`);
      setStatus("exported");
      setMessage("Protected PNG created. Redactions are permanently drawn into the new image pixels.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not export this image.");
    }
  }

  function reset() {
    scanGeneration.current += 1;
    if (activeWorker.current) {
      void activeWorker.current.terminate();
      activeWorker.current = null;
    }
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = "";
    clearExport();
    setImageSrc("");
    setFileName("");
    setDetections([]);
    setStatus("idle");
    setProgress(0);
    setMessage("");
    setManualMode(false);
    setDraft(null);
    dragOrigin.current = null;
  }

  const selectedCount = detections.filter((item) => item.selected).length;
  const image = imageRef.current;
  const scaleX = image && image.clientWidth ? image.clientWidth / image.naturalWidth : 1;
  const scaleY = image && image.clientHeight ? image.clientHeight / image.naturalHeight : 1;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#" onClick={(e) => { e.preventDefault(); reset(); window.scrollTo({ top: 0, behavior: "smooth" }); }} aria-label="ShareSafe home">
          <span className="brand-mark"><ShieldIcon /></span><span>ShareSafe</span>
        </a>
        <nav className="header-nav" aria-label="Main navigation">
          <a href="/pdf">PDF redaction</a>
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="button button-small" href="/pdf">Protect a PDF ↗</a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> PRIVATE BY DESIGN</div>
          <h1>Clean screenshots<br /><span>before you share.</span></h1>
          <p>Find sensitive details, cover what matters, and export a fresh PNG — right in your browser.</p>
          <a className="button" href="#workspace">Protect a screenshot <ArrowIcon /></a><a className="pdf-hero-link" href="/pdf">Working with a PDF? Open PDF redaction ↗</a>
          <div className="hero-note"><LockIcon /> Your image stays on this device. No account. No uploads.</div>
        </div>
        <div className="hero-art" aria-label="Illustration of a screenshot with sensitive information covered">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <div className="art-card">
            <div className="art-window"><span /><span /><span /><b>support-chat.png</b><i>PNG</i></div>
            <div className="art-content">
              <div className="art-avatar">JD</div>
              <div className="art-lines"><span className="line long" /><span className="line medium" /><span className="line short" /></div>
              <div className="art-label">PERSONAL DETAILS</div>
              <div className="art-redaction redaction-one" /><div className="art-redaction redaction-two" />
              <div className="art-message"><span /><span /><span /></div>
            </div>
            <div className="art-stamp"><ShieldIcon /><span>READY<br />TO SHARE</span></div>
          </div>
          <div className="float-tag tag-top"><span className="tag-check">✓</span> Sensitive details found</div>
          <div className="float-tag tag-bottom"><span className="tag-spark">✳</span> Redacted for privacy</div>
          <div className="art-dots" />
        </div>
      </section>

      <div className="trust-strip">
        <div><span className="trust-icon"><LockIcon /></span><span><strong>Local processing</strong><small>Image stays in your browser</small></span></div>
        <div><span className="trust-icon"><EyeOffIcon /></span><span><strong>You stay in control</strong><small>Review every suggestion</small></span></div>
        <div><span className="trust-icon"><FileIcon /></span><span><strong>Fresh PNG export</strong><small>Redactions baked into pixels</small></span></div>
      </div>

      <section id="workspace" className="workspace-section">
        <div className="section-heading">
          <div><div className="eyebrow">THE WORKSPACE</div><h2>Make it safe to share.</h2><p>Upload a screenshot to start. You decide what gets covered.</p></div>
          {imageSrc && <button className="button button-quiet" onClick={reset}><RefreshIcon /> Start over</button>}
        </div>

        {!imageSrc ? (
          <div className={`upload-card ${dragging ? "is-dragging" : ""}`} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}>
            <div className="upload-icon"><UploadIcon /></div>
            <h3>Drop your screenshot here</h3>
            <p>Or choose a file from your device</p>
            <label className="button upload-button">Choose an image <input aria-label="Choose an image file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={onFileChange} /></label>
            <div className="file-hint"><FileIcon /> PNG, JPG or JPEG <span>·</span> Up to 15 MB</div>
            <div className="privacy-inline"><LockIcon /> Processed locally. Nothing is uploaded or saved.</div>
            {status === "error" && message && <div className="alert alert-error" role="alert">{message}</div>}
          </div>
        ) : (
          <div className="editor-layout">
            <section className="preview-panel panel">
              <div className="panel-header"><div><span className="panel-kicker">IMAGE PREVIEW</span><div className="file-title"><FileIcon /> <span title={fileName}>{fileName}</span></div></div><span className="image-chip">ORIGINAL PREVIEW</span></div>
              <div className={`image-stage ${manualMode ? "draw-mode" : ""}`} ref={previewRef} onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={finishDraw} onPointerCancel={finishDraw} style={{ touchAction: manualMode ? "none" : "auto" }}>
                {/* The source image is only shown as an editing preview. Export always re-renders it with selected rectangles. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img ref={imageRef} src={imageSrc} alt="Screenshot being reviewed for redaction" draggable={false} />
                {detections.map((item) => <button type="button" key={item.id} aria-label={`${item.selected ? "Selected" : "Unselected"} ${item.category}: ${item.text}. Click to toggle redaction.`} title={`${item.category}: ${item.text}`} onPointerDown={(e) => { if (manualMode) e.stopPropagation(); }} onClick={() => { if (!manualMode) toggleDetection(item.id); }} className={`redaction-overlay ${item.selected ? "is-selected" : "is-unselected"}`} style={{ left: item.rect.x * scaleX, top: item.rect.y * scaleY, width: Math.max(item.rect.width * scaleX, 2), height: Math.max(item.rect.height * scaleY, 2), pointerEvents: manualMode ? "none" : "auto" }} />)}
                {draft && <div className="redaction-overlay draft-overlay" style={{ left: draft.x * scaleX, top: draft.y * scaleY, width: draft.width * scaleX, height: draft.height * scaleY }} />}
                {status === "loading" && <div className="scan-overlay"><div className="spinner" /><strong>Scanning in your browser</strong><span>{message || "Loading English OCR…"} {progress}%</span><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><button className="button button-quiet" onClick={reset}>Cancel scan</button></div>}
              </div>
              <div className="preview-legend"><span><i className="legend-selected" /> Selected for redaction</span><span><i className="legend-unselected" /> Not selected</span></div>
              {manualMode && <div className="draw-hint"><span className="draw-cross">＋</span> Drag across the image to draw a redaction. <button onClick={() => { setManualMode(false); setDraft(null); dragOrigin.current = null; }}>Cancel</button></div>}
              <div className="preview-actions"><button className={`button ${manualMode ? "button-active" : "button-secondary"}`} onClick={() => setManualMode((value) => !value)}><CrosshairIcon /> {manualMode ? "Drawing mode on" : "Draw a redaction"}</button><span className="action-note">Draw over any detail OCR missed.</span></div>
            </section>

            <aside className="side-column">
              <section className="panel review-panel">
                <div className="panel-header review-header"><div><span className="panel-kicker">REVIEW</span><h3>Detected details</h3></div><span className="count-badge">{selectedCount} selected</span></div>
                {status === "loading" ? <div className="review-empty"><div className="spinner" /><strong>Reading text…</strong><span>English OCR runs on this device.</span></div> : detections.length ? (
                  <div className="detection-list">{detections.map((item) => <div className={`detection-item ${item.selected ? "chosen" : ""}`} key={item.id}>
                    <label className="detection-check"><input type="checkbox" checked={item.selected} onChange={() => toggleDetection(item.id)} /><span className="custom-check">✓</span></label>
                    <span className="category-icon">{categoryIcons[item.category]}</span>
                    <button className="detection-copy" onClick={() => toggleDetection(item.id)}><strong>{item.category}</strong><span title={item.text}>{item.text}</span><small>{item.confidence === "Heuristic" ? "Heuristic match" : "Pattern match"}</small></button>
                    <button className="delete-detection" title="Remove this redaction" aria-label={`Remove ${item.text} redaction`} onClick={() => deleteDetection(item.id)}>×</button>
                  </div>)}</div>
                ) : <div className="review-empty"><div className="empty-symbol">⌕</div><strong>No pattern matches found</strong><span>You can still draw boxes over anything you want to hide.</span></div>}
                <div className="review-footnote"><LockIcon /> Suggestions can miss details or flag text incorrectly. Review the image carefully.</div>
              </section>

              <section className="panel export-panel">
                <div className="panel-header"><div><span className="panel-kicker">PROTECTED COPY</span><h3>Export your image</h3></div><span className="export-icon"><DownloadIcon /></span></div>
                <p>Selected rectangles will be permanently drawn into a new PNG file.</p>
                <button className="button export-button" onClick={() => void exportImage()} disabled={status === "loading" || selectedCount === 0}><ShieldIcon /> Create protected PNG <ArrowIcon /></button>
                {exportUrl && <a className="button download-button" href={exportUrl} download={exportName}><DownloadIcon /> Download {exportName}</a>}
                {status === "exported" && <div className="alert alert-success" role="status"><span>✓</span><div><strong>PNG ready to download</strong><small>Redaction rectangles are embedded in the image pixels.</small></div></div>}
                <div className="metadata-note"><div className="metadata-title"><ShieldIcon /> Metadata note</div><p>Exported as a fresh PNG; original image metadata is not copied by this export path. Metadata stripping is expected via re-encoding, but is not independently verified.</p></div>
              </section>
            </aside>
          </div>
        )}
        {imageSrc && message && <div className={`status-message ${status === "error" ? "status-error" : status === "exported" ? "status-success" : ""}`} role={status === "error" ? "alert" : "status"}><span className="status-dot" />{message}</div>}
      </section>

      <section id="how-it-works" className="how-section">
        <div className="eyebrow">SIMPLE BY DESIGN</div><h2>Three steps. You’re in control.</h2><p className="how-intro">No complicated tools. No account. Just a safer image to share.</p>
        <div className="steps-grid">
          <article className="step-card"><span className="step-number">01</span><div className="step-icon"><UploadIcon /></div><h3>Upload privately</h3><p>Choose a screenshot. The image and OCR stay in your browser session.</p></article>
          <article className="step-card"><span className="step-number">02</span><div className="step-icon"><ScanIcon /></div><h3>Review suggestions</h3><p>Pattern matching flags likely emails, Pakistani phone numbers and addresses, IDs, URLs and more. You make the call.</p></article>
          <article className="step-card"><span className="step-number">03</span><div className="step-icon"><ShieldIcon /></div><h3>Redact and export</h3><p>Cover sensitive regions with opaque pixels and create a new PNG to share.</p></article>
        </div>
      </section>

      <section id="privacy" className="privacy-section"><div className="privacy-emblem"><LockIcon /></div><div><div className="eyebrow">YOUR PRIVACY, FIRST</div><h2>Private by how it works.</h2><p>Image analysis and OCR happen locally in your browser. ShareSafe does not upload your image or save image history. OCR language files may be downloaded by Tesseract.js the first time you scan; your image and recognized text are not sent with that request.</p></div><div className="privacy-points"><span><CheckIcon /> No account or cloud storage</span><span><CheckIcon /> No saved image history</span><span><CheckIcon /> You choose each redaction</span></div></section>

      <footer className="site-footer"><a className="brand footer-brand" href="#"><span className="brand-mark"><ShieldIcon /></span><span>ShareSafe</span></a><span>Make sharing a little safer.</span><p>Pattern detection is not comprehensive. Check every detail before sharing.</p></footer>
    </main>
  );
}

function ShieldIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>; }
function ArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>; }
function LockIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5 0 8.5 4.2 9.5 7-.4 1.2-1.3 2.5-2.5 3.6M6.2 6.3C3.9 7.7 2.3 10 1.5 12c1 2.8 4.5 7 10.5 7 1 0 1.9-.2 2.8-.4" /></svg>; }
function FileIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V21H6z" /><path d="M14 3.5v4h4M9 12h6m-6 3.5h6" /></svg>; }
function UploadIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M4 15v5h16v-5" /></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.5-3" /></svg>; }
function CrosshairIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></svg>; }
function DownloadIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M4 16v4h16v-4" /></svg>; }
function ScanIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V4h4m8 0h4v4M20 16v4h-4m-8 0H4v-4M4 12h16" /></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>; }
