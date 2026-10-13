// Drawing slides and laid-out pages for print, preview and export: slide
// renders as pictures on a canvas, colour modes, page geometry as DOM
// (for the print preview and the printed pages), and text measurement in
// the faces the PDF writer uses.

import { FRAME_COLOR } from "./page-layout.js";

const images = new Map();
// The decoded picture for a slide render's URL, kept while it is in use.
export async function loadImage(src) {
  let entry = images.get(src);
  if (!entry) {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    entry = image.decode().then(() => image);
    images.set(src, entry);
    if (images.size > 48) images.delete(images.keys().next().value);
    entry.catch(() => images.delete(src));
  }
  return entry;
}

export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// A slide drawn on a white canvas of the given pixel size.
export async function rasterize(src, width, height, colorMode = "color") {
  const image = await loadImage(src);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  applyColorMode(canvas, colorMode);
  return canvas;
}

// Grayscale weighs the channels by brightness; pure black and white sets
// each pixel to whichever it is nearer.
export function applyColorMode(canvas, mode) {
  if (mode !== "grayscale" && mode !== "bw") return canvas;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let v = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    if (mode === "bw") v = v < 160 ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  context.putImageData(data, 0, 0);
  return canvas;
}

export const canvasBlob = (canvas, type = "image/png", quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The slide could not be drawn as an image.")),
      type,
      quality,
    ),
  );

let measureContext = null;
export const PDF_FONT = "Helvetica, Arial, sans-serif";
// Text width in points for the PDF writer's Helvetica (Arial shares its
// metrics), so wrapped lines fit the page they are drawn on.
export function measureText(text, size = 12, bold = false) {
  measureContext ||= createCanvas(1, 1).getContext("2d");
  measureContext.font = `${bold ? "bold " : ""}${size}px ${PDF_FONT}`;
  return measureContext.measureText(String(text)).width;
}

// A laid-out page as DOM in points: the print preview scales it, and
// printing places one per sheet. `sources(i)` is slide i's render URL and
// `alts(i)` its description.
export function pageElement(
  page,
  sources,
  { colorMode = "color", alts = () => "", className = "" } = {},
) {
  const node = document.createElement("div");
  node.className = `export-page ${className}`.trim();
  node.style.width = `${page.width}pt`;
  node.style.height = `${page.height}pt`;
  for (const item of page.items) {
    if (item.kind === "slide") {
      const box = document.createElement("div");
      box.className = "export-page-slide";
      Object.assign(box.style, {
        left: `${item.x}pt`,
        top: `${item.y}pt`,
        width: `${item.w}pt`,
        height: `${item.h}pt`,
      });
      if (item.frame) box.style.outline = `0.75pt solid ${FRAME_COLOR}`;
      const img = document.createElement("img");
      img.src = sources(item.slide);
      img.alt = alts(item.slide) || "";
      img.decoding = "async";
      if (colorMode === "grayscale") img.style.filter = "grayscale(1)";
      if (colorMode === "bw")
        img.style.filter = "grayscale(1) contrast(12) brightness(1.15)";
      box.append(img);
      node.append(box);
    } else if (item.kind === "text") {
      const span = document.createElement("span");
      span.className = "export-page-text";
      span.textContent = item.text;
      Object.assign(span.style, {
        top: `${item.y - item.size * 0.8}pt`,
        fontSize: `${item.size}pt`,
        fontWeight: item.bold ? "700" : "400",
        color: item.color || "#000",
        fontFamily: PDF_FONT,
      });
      if (item.align === "right") span.style.right = `${page.width - item.x}pt`;
      else span.style.left = `${item.x}pt`;
      node.append(span);
    } else if (item.kind === "line") {
      const line = document.createElement("div");
      line.className = "export-page-rule";
      const horizontal = Math.abs(item.y1 - item.y2) < 0.01;
      Object.assign(line.style, {
        left: `${Math.min(item.x1, item.x2)}pt`,
        top: `${Math.min(item.y1, item.y2)}pt`,
        width: horizontal
          ? `${Math.abs(item.x2 - item.x1)}pt`
          : `${item.width}pt`,
        height: horizontal
          ? `${item.width}pt`
          : `${Math.abs(item.y2 - item.y1)}pt`,
        background: item.color,
      });
      node.append(line);
    }
  }
  return node;
}
