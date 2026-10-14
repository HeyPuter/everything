// PDF and picture exports drawn from the slides' renders.

import { PdfWriter } from "./pdf-writer.js";
import { layoutPages } from "./page-layout.js";
import {
  PDF_FONT,
  canvasBlob,
  createCanvas,
  measureText,
  rasterize,
} from "./render.js";

const abortError = () => new DOMException("Export cancelled.", "AbortError");
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

// Text the standard PDF fonts cannot show is drawn as a picture instead.
function textPicture(item, scale = 4) {
  const width = Math.ceil(measureText(item.text, item.size, item.bold) + 2);
  const height = Math.ceil(item.size * 1.4);
  const canvas = createCanvas(width * scale, height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.scale(scale, scale);
  context.font = `${item.bold ? "bold " : ""}${item.size}px ${PDF_FONT}`;
  context.fillStyle = item.color || "#000";
  context.textBaseline = "alphabetic";
  context.fillText(item.text, 1, item.size * 1.05);
  return {
    canvas,
    width,
    height,
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

// slides: [{ number, title, notes, outline, src }]. Resolves to PDF bytes.
export async function exportPdf({
  slides,
  layout,
  slideWidth,
  slideHeight,
  dpi = 200,
  quality = "high",
  colorMode = "color",
  info = {},
  signal,
  progress,
  ...options
}) {
  const pages = layoutPages(slides, {
    ...options,
    layout,
    slideWidth,
    slideHeight,
    measure: measureText,
  });
  const pdf = new PdfWriter({ producer: "Presentation", ...info });
  // Each slide is drawn once, at the largest size any page shows it.
  const largest = new Map();
  for (const page of pages)
    for (const item of page.items)
      if (item.kind === "slide")
        largest.set(item.slide, Math.max(largest.get(item.slide) || 0, item.w));
  const embedded = new Map();
  let done = 0;
  for (const [index, widthPt] of largest) {
    if (signal?.aborted) throw abortError();
    const w = Math.max(16, Math.round((widthPt / 72) * dpi));
    const h = Math.max(16, Math.round((w * slideHeight) / slideWidth));
    const canvas = await rasterize(slides[index].src, w, h, colorMode);
    if (quality === "lossless") {
      const data = canvas
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, w, h).data;
      embedded.set(index, pdf.addPixels(data, w, h));
    } else {
      const blob = await canvasBlob(canvas, "image/jpeg", 0.92);
      embedded.set(
        index,
        pdf.addJpeg(new Uint8Array(await blob.arrayBuffer()), w, h, {
          channels: 3,
        }),
      );
    }
    progress?.(++done / (largest.size + 1));
    await nextTask();
  }
  const bookmarked = new Set();
  pages.forEach((page, n) => {
    const out = pdf.addPage(page.width, page.height);
    for (const item of page.items) {
      if (item.kind === "slide") {
        out.clip(0, 0, page.width, page.height);
        out.image(embedded.get(item.slide), item.x, item.y, item.w, item.h);
        // The slide's words go over its picture unpainted, so the PDF can
        // be searched and its text selected and copied.
        const k = item.w / (slideWidth / 12700);
        for (const block of slides[item.slide].textBlocks || []) {
          const size = Math.max(1, block.size * k);
          const x = item.x + (block.x / 12700) * k + 7.2 * k;
          let baseline = item.y + (block.y / 12700) * k + 3.6 * k;
          for (const line of block.lines) {
            baseline += size * 1.2;
            out.text(line, x, baseline - size * 0.2, size, {
              invisible: true,
            });
          }
        }
        out.restore();
        if (item.frame)
          out.rect(item.x, item.y, item.w, item.h, {
            width: 0.75,
            color: "#5f5f5f",
          });
        const s = slides[item.slide];
        if (!bookmarked.has(item.slide) && layout !== "handouts") {
          bookmarked.add(item.slide);
          pdf.addBookmark(
            s.title ? `${s.number}. ${s.title}` : `Slide ${s.number}`,
            n,
          );
        }
      } else if (item.kind === "text") {
        const width = measureText(item.text, item.size, item.bold);
        const drawn = out.text(item.text, item.x, item.y, item.size, {
          bold: item.bold,
          color: item.color,
          width,
          align: item.align,
        });
        if (!drawn) {
          const picture = textPicture(item);
          const name = pdf.addPixels(
            picture.data,
            picture.canvas.width,
            picture.canvas.height,
          );
          const left = item.align === "right" ? item.x - picture.width : item.x;
          out.image(
            name,
            left - 1,
            item.y - item.size * 1.05,
            picture.width,
            picture.height,
          );
        }
      } else if (item.kind === "line")
        out.line(item.x1, item.y1, item.x2, item.y2, {
          width: item.width,
          color: item.color,
        });
      else if (item.kind === "rect")
        out.rect(item.x, item.y, item.w, item.h, {
          width: item.width,
          color: item.color,
        });
    }
    if (layout === "outline" && n === 0)
      pdf.addBookmark(info.title || "Outline", 0);
  });
  progress?.(1);
  return new Blob([pdf.output()], { type: "application/pdf" });
}

// Slides as PNG or JPEG pictures `width` pixels wide.
export async function slidePictures({
  slides,
  width,
  slideWidth,
  slideHeight,
  type = "image/png",
  signal,
  progress,
}) {
  const height = Math.max(1, Math.round((width * slideHeight) / slideWidth));
  const out = [];
  for (const [i, s] of slides.entries()) {
    if (signal?.aborted) throw abortError();
    const canvas = await rasterize(s.src, width, height);
    out.push(
      await canvasBlob(canvas, type, type === "image/jpeg" ? 0.92 : undefined),
    );
    progress?.((i + 1) / slides.length);
    await nextTask();
  }
  return out;
}
