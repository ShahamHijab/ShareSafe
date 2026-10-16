"use client";

import { ChangeEvent, DragEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { createWorker, PSM } from "tesseract.js";
import { Header } from "@/components/Header";
import { DownloadIcon, LockIcon, PenIcon, RefreshIcon, ShieldIcon, UploadIcon } from "@/components/Icons";
import { detectPatterns, type OCRWord } from "@/lib/detectPatterns";
import { downloadBlob } from "@/lib/download";
import { renderRedactedPNG } from "@/lib/imageExport";
import type { Detection, Rect } from "@/lib/types";

const MAX_BYTES = 15 * 1024 * 1024;
const categoryIcons: Record<string, string> = {
  Email: "@", "Pakistan phone": "☎", "Pakistan address": "⌂", CNIC: "ID",
  "IP address": "IP", URL: "↗", "Possible secret": "••",
};

export default function ImagePage() {
  const [fileName, setFileName] = useState("");
  const [imageSrc, setImageSrc] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error" | "exported">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, setPreviewSize] = useState({ width: 0, height: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const sourceUrlRef = useRef("");
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const activeWorker = useRef<{ terminate: () => Promise<unknown> } | null>(null);
  const scanGeneration = useRef(0);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (activeWorker.current) void activeWorker.current.terminate();
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !imageSrc) { setPreviewSize({ width: 0, height: 0 }); return; }
    const measure = () => {
      const bounds = image.getBoundingClientRect();
      setPreviewSize({ width: bounds.width, height: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    return () => observer.disconnect();
  }, [imageSrc]);

  async function loadFile(file?: File) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setStatus("error"); setMessage("Choose a PNG, JPG, or JPEG image."); return;
    }
    if (file.size > MAX_BYTES) {
      setStatus("error"); setMessage("This image is over 15 MB. Choose a smaller file."); return;
    }
    const generation = ++scanGeneration.current;
    if (activeWorker.current) {
      await activeWorker.current.terminate().catch(() => undefined);
      activeWorker.current = null;
    }
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    setFileName(file.name);
    setDetections([]);
    setDraft(null);
    setManualMode(false);
    setProgress(0);
    setMessage("Warming up the scanner…");
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
      if (generation !== scanGeneration.current) { await worker.terminate(); return; }
      activeWorker.current = worker;
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
        const enhanced = Math.max(0, Math.min(255, (gray - 128) * 1.18 + 128));
        pixels.data[i] = enhanced; pixels.data[i + 1] = enhanced; pixels.data[i + 2] = enhanced;
      }
      context.putImageData(pixels, 0, 0);

      const firstPass = await worker.recognize(canvas);
      if (generation !== scanGeneration.current) {
        if (activeWorker.current === worker) activeWorker.current = null;
        await worker.terminate();
        return;
      }
      // Sparse-text mode is better for chat bubbles, captions and text scattered around screenshots.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      const secondPass = await worker.recognize(canvas);
      if (generation !== scanGeneration.current) {
        if (activeWorker.current === worker) activeWorker.current = null;
        await worker.terminate();
        return;
      }
      if (activeWorker.current === worker) activeWorker.current = null;
      await worker.terminate();

      // Keep OCR passes separate so unrelated words from different passes never get joined.
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

      // Normal pass is the source of truth for heuristics (addresses); sparse pass only
      // supplements explicit pattern matches such as phones, CNICs, emails and URLs.
      const supplemental = sparseDetections.filter((candidate) =>
        candidate.confidence === "Pattern match" &&
        !primaryDetections.some((existing) => {
          if (existing.category !== candidate.category) return false;
          const a = existing.rect;
          const b = candidate.rect;
          const iw = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
          const ih = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
          const smallerArea = Math.min(a.width * a.height, b.width * b.height);
          const sameText = existing.text.replace(/\D/g, "") === candidate.text.replace(/\D/g, "") &&
            existing.text.replace(/\D/g, "").length >= 7;
          return sameText || (smallerArea > 0 && (iw * ih) / smallerArea >= 0.55);
        })
      );
      const finalDetections = [...primaryDetections, ...supplemental];
      const wordCount = Math.max(primaryWords.length, sparseWords.length);
      setDetections(finalDetections);
      setStatus("ready");
      setMessage(wordCount
        ? `Scan done — ${finalDetections.length} spot${finalDetections.length === 1 ? "" : "s"} flagged. Tap any box to toggle it.`
        : "No readable English text found. Draw boxes manually to cover anything.");
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
    event.preventDefault(); setDragging(false);
    void loadFile(event.dataTransfer.files?.[0]);
  }
  function toggleDetection(id: string) {
    setDetections((items) => items.map((item) => item.id === id ? { ...item, selected: !item.selected } : item));
  }

  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    const bounds = image?.getBoundingClientRect();
    if (!image || !bounds || !bounds.width || !bounds.height) return null;
    return {
      x: Math.max(0, Math.min(image.naturalWidth, (event.clientX - bounds.left) * image.naturalWidth / bounds.width)),
      y: Math.max(0, Math.min(image.naturalHeight, (event.clientY - bounds.top) * image.naturalHeight / bounds.height)),
    };
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
    const o = dragOrigin.current;
    setDraft({ x: Math.min(o.x, position.x), y: Math.min(o.y, position.y), width: Math.abs(position.x - o.x), height: Math.abs(position.y - o.y) });
  }
  function finishDraw(event: PointerEvent<HTMLDivElement>) {
    if (!manualMode || !dragOrigin.current) return;
    const position = pointerPosition(event);
    const o = dragOrigin.current;
    dragOrigin.current = null;
    if (!position) { setDraft(null); return; }
    const rect = { x: Math.min(o.x, position.x), y: Math.min(o.y, position.y), width: Math.abs(position.x - o.x), height: Math.abs(position.y - o.y) };
    setDraft(null);
    if (rect.width < 4 || rect.height < 4) return;
    setDetections((items) => [...items, {
      id: `manual-${Date.now()}`, category: "Possible secret", text: "Manual redaction",
      confidence: "Heuristic", rect, selected: true,
    }]);
    setManualMode(false);
    setMessage("Box added. It'll be burned into the download.");
  }

  async function exportImage() {
    const image = imageRef.current;
    if (!image || !image.complete) return;
    try {
      const blob = await renderRedactedPNG(image, detections);
      downloadBlob(blob, `${fileName.replace(/\.[^.]+$/, "") || "sharesafe"}-protected.png`);
      setStatus("exported");
      setMessage("Saved! Redactions are baked into the new image's pixels.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not export this image.");
    }
  }

  function reset() {
    scanGeneration.current += 1;
    if (activeWorker.current) { void activeWorker.current.terminate(); activeWorker.current = null; }
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = "";
    setImageSrc(""); setFileName(""); setDetections([]); setStatus("idle");
    setProgress(0); setMessage(""); setManualMode(false); setDraft(null);
    dragOrigin.current = null;
  }

  const selectedCount = detections.filter((d) => d.selected).length;
  const image = imageRef.current;
  const scaleX = image && image.clientWidth ? image.clientWidth / image.naturalWidth : 1;
  const scaleY = image && image.clientHeight ? image.clientHeight / image.naturalHeight : 1;

  return (
    <main className="tool tool-image">
      <Header />
      <div className="tool-wrap">
        <div className="tool-title">
          <span className="tool-emoji">🖼️</span>
          <div><h1>Image redaction</h1><p>Drop it in. Tap what to hide. Download.</p></div>
          {imageSrc && <button className="btn btn-ghost" onClick={reset}><RefreshIcon /> Start over</button>}
        </div>

        <p className="metadata-note"><ShieldIcon /> Source metadata is removed from every export.</p>

        {!imageSrc ? (
          <div className={`dropzone ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
            onDrop={onDrop}>
            <div className="drop-icon"><UploadIcon /></div>
            <h2>Drop your image here</h2>
            <p>PNG, JPG or JPEG · up to 15 MB</p>
            <label className="btn btn-primary file-btn">Choose an image
              <input aria-label="Choose an image file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={onFileChange} />
            </label>
            <span className="drop-note"><LockIcon /> Processed locally. Nothing is uploaded.</span>
            {status === "error" && message && <div className="alert alert-error" role="alert">{message}</div>}
          </div>
        ) : (
          <div className="editor">
            <section className="card stage-card">
              <div className="card-bar">
                <span className="file-name" title={fileName}>{fileName}</span>
                <button className={`btn ${manualMode ? "btn-on" : "btn-soft"}`} onClick={() => { setManualMode((v) => !v); setDraft(null); dragOrigin.current = null; }}>
                  <PenIcon /> {manualMode ? "Drag on the image…" : "Draw a box"}
                </button>
              </div>
              <div className={`image-stage ${manualMode ? "draw-mode" : ""}`}
                onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={finishDraw} onPointerCancel={finishDraw}
                style={{ touchAction: manualMode ? "none" : "auto" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img ref={imageRef} src={imageSrc} alt="Image being reviewed for redaction" draggable={false} />
                {detections.map((item) => (
                  <button type="button" key={item.id}
                    aria-label={`${item.selected ? "Selected" : "Unselected"} ${item.category}: ${item.text}. Click to toggle redaction.`}
                    title={`${item.category}: ${item.text}`}
                    onPointerDown={(e) => { if (manualMode) e.stopPropagation(); }}
                    onClick={() => { if (!manualMode) toggleDetection(item.id); }}
                    className={`redaction-overlay ${item.selected ? "is-selected" : "is-unselected"}`}
                    style={{ left: item.rect.x * scaleX, top: item.rect.y * scaleY, width: Math.max(item.rect.width * scaleX, 2), height: Math.max(item.rect.height * scaleY, 2), pointerEvents: manualMode ? "none" : "auto" }} />
                ))}
                {draft && <div className="redaction-overlay draft-overlay" style={{ left: draft.x * scaleX, top: draft.y * scaleY, width: draft.width * scaleX, height: draft.height * scaleY }} />}
                {status === "loading" && (
                  <div className="scan-overlay">
                    <div className="spinner" />
                    <strong>Sniffing out secrets…</strong>
                    <span>{message} {progress}%</span>
                    <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
                  </div>
                )}
              </div>
            </section>

            <aside className="side">
              <section className="card">
                <div className="card-bar"><h2>Found</h2><span className="badge">{selectedCount} to hide</span></div>
                {status === "loading" ? (
                  <div className="empty"><div className="spinner" /><span>Reading text on this device…</span></div>
                ) : detections.length ? (
                  <div className="det-list">
                    {detections.map((item) => (
                      <button key={item.id} className={`det ${item.selected ? "on" : ""}`} onClick={() => toggleDetection(item.id)}>
                        <span className="det-check">{item.selected ? "✓" : ""}</span>
                        <span className="det-icon">{categoryIcons[item.category]}</span>
                        <span className="det-copy"><strong>{item.category}</strong><span title={item.text}>{item.text}</span></span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty"><span className="empty-emoji">🕵️</span><span>Nothing flagged. Draw a box to cover anything yourself.</span></div>
                )}
              </section>

              <button className="btn btn-primary btn-big" onClick={() => void exportImage()} disabled={status === "loading" || selectedCount === 0}>
                <DownloadIcon /> Download protected PNG
              </button>
              {message && status !== "loading" && (
                <p className={`status ${status === "error" ? "status-error" : status === "exported" ? "status-ok" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p>
              )}
              <p className="fine">Auto-detection can miss things. Check the result before you share it.</p>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
