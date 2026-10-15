import type { Detection } from "./types";

export function renderRedactedPNG(image: HTMLImageElement, detections: Detection[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      reject(new Error("Your browser could not create a canvas for export."));
      return;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    for (const detection of detections.filter((item) => item.selected)) {
      const { x, y, width, height } = detection.rect;
      context.fillRect(Math.floor(x), Math.floor(y), Math.ceil(width), Math.ceil(height));
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG export failed. Try a different image or browser."));
    }, "image/png");
  });
}
