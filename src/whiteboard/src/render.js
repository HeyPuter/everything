import { capParts } from "./connector-caps.js";
import { drawGrid } from "./grid.js";
import { rotationOf, boxPoint, objectBounds } from "./geometry.js";
import { rotationBox, rotationHandle } from "./rotation.js";
import { drawTags, tagCatalog, clearTagLayouts } from "./tag-renderer.js";
import { tagFooter } from "./tags.js";
import { drawTaskBadge } from "./planning/task-renderer.js";
import { mindLines } from "./mind-map.js";
import { tableLayout } from "./table-layout.js";
import { tableFont, tableFontSize, tableTextAlign } from "./table-sizing.js";
import { visibleMindItems, mindVisibility } from "./mind-visibility.js";
import {
  bounds,
  escape,
  stackedItems,
  resizeBounds,
  DETAIL_ZOOM,
  RESIZE_HANDLES,
} from "./model.js";
import { linkColor, inkOver as inkOverHighlight } from "./text-link-data.js";
import {
  fontFamily,
  fontStack,
  itemFontFamilies,
  loadFontFamily,
  loadItemFonts,
  fontFamilyReady,
} from "./fonts.js";
import {
  textStyle,
  richTextLayout,
  listTextLayout,
  cachedWrapText,
  wrappedLineWidths,
  shapeTextLayout,
  boxedText,
  textClip,
  fitTextLayout,
  canAutoFitText,
  growsWithText,
  autoHeightLayout,
  reflowTextItems,
  clearTextLayoutCache,
  textLayoutVersion,
} from "./text.js";
import { updateConnectors } from "./scene.js";
import { drawShape } from "./shape-art.js";
import { SHAPE_COLORS, shapeBorder } from "./shape-specs.js";
export { wrapText } from "./text.js";
import {
  connectorPath,
  connectorLabel,
  clearConnectorLabelCache,
} from "./connectors.js";
import { imageLayout } from "./image-crop.js";
import { drawEmbedCard } from "./content/embed-card.js";
import { fileDetails } from "./file-details.js";

const previews = new Map();
const canvasFonts = new WeakMap();
// When a family last failed to load, as while offline. It is asked for
// again after half a minute or once the connection is back, not on every
// repaint: a board pans at sixty repaints a second.
const fontFailures = new Map();
const FONT_RETRY_MS = 30_000;
// Text measured before a font loaded is measured again once it has. One
// load is reported to each canvas that asked for it, to the font set's
// `loadingdone` and to `fonts.ready`, and each of them cleared every layout,
// which painted every library preview again each time. The layouts are
// cleared only when a font face has loaded since they last were; a font set
// that cannot be counted clears them every time. Says whether they were.
let facesMeasured = -1;
export function refreshTextLayouts(fontSet = globalThis.document?.fonts) {
  let loaded = -1;
  if (typeof fontSet?.[Symbol.iterator] === "function") {
    loaded = 0;
    for (const face of fontSet) if (face.status === "loaded") loaded++;
    if (loaded === facesMeasured) return false;
  }
  facesMeasured = loaded;
  clearTextLayoutCache();
  clearTagLayouts();
  clearConnectorLabelCache();
  return true;
}
const fontWaits = (id) =>
  Date.now() - (fontFailures.get(id) ?? -Infinity) < FONT_RETRY_MS;
function fontFailed(ids) {
  if (!fontFailures.size)
    globalThis.window?.addEventListener("online", () => fontFailures.clear(), {
      once: true,
    });
  for (const id of ids) fontFailures.set(id, Date.now());
}
const images = new Map();
export const IMAGE_RETRY_MS = 10000;
export const IMAGE_PLACEHOLDER = { fill: "#e4e7eb", line: "#b6bcc4" };
export function imageFor(src) {
  let entry = images.get(src);
  // An image that could not load is tried again after a while: the network
  // may be back, or the asset may have arrived meanwhile.
  if (entry?.failed && performance.now() - entry.failed > IMAGE_RETRY_MS) {
    images.delete(src);
    entry = null;
  }
  if (entry) {
    // Keep least-recently-used order so eviction skips images still drawn.
    images.delete(src);
    images.set(src, entry);
    entry.used = performance.now();
  } else {
    const image = new window.Image();
    const ready = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(Error("Could not decode an image."));
    });
    // One pending repaint per canvas: registering a callback on every paint
    // made each load replay all earlier paints, doubling work per image.
    entry = { image, ready, waiting: new Map(), used: performance.now() };
    ready.then(
      () => {
        const repaints = [...entry.waiting.values()];
        entry.waiting.clear();
        for (const repaint of repaints)
          try {
            repaint();
          } catch {
            /* A failed repaint must not prevent other canvases from updating. */
          }
      },
      () => {
        entry.failed = performance.now();
        entry.waiting.clear();
      },
    );
    image.src = src;
    images.set(src, entry);
    // Evict beyond 64 only images not drawn recently. Evicting by count alone
    // recreated every image on each paint once more than 64 were visible.
    for (const [key, old] of images) {
      if (images.size <= 64 || entry.used - old.used < 2000) break;
      images.delete(key);
    }
  }
  return entry;
}

// Text layouts are cached per object, so a connector keeps one label object
// while every field of it stays the same; a new one each repaint would
// measure formatted labels again every frame.
const connectorLabels = new WeakMap();
function labelObject(i, label) {
  const previous = connectorLabels.get(i);
  if (previous) {
    const keys = Object.keys(label);
    if (
      keys.length === Object.keys(previous).length &&
      keys.every((key) => previous[key] === label[key])
    )
      return previous;
  }
  connectorLabels.set(i, label);
  return label;
}

// A sticky note casts a soft shadow, as paper on a wall does, and only the
// note's paper casts it: its text and tags are drawn without one. Shadow
// offsets and blur ignore the transform, so they follow the zoom and pixel
// ratio here to keep the shadow in board pixels. Zoomed far out it would be
// under a pixel and is skipped, which also spares a blur per note on boards
// seen whole.
function noteShadow(ctx, fill) {
  const m = ctx.getTransform(),
    scale = Math.hypot(m.a, m.b);
  if (scale * NOTE_SHADOW.blur < 1) return fill();
  ctx.save();
  ctx.shadowColor = NOTE_SHADOW.color;
  ctx.shadowBlur = NOTE_SHADOW.blur * scale;
  ctx.shadowOffsetY = NOTE_SHADOW.offset * scale;
  fill();
  ctx.restore();
}
export const NOTE_SHADOW = {
  color: "rgba(15, 23, 42, 0.18)",
  blur: 8,
  offset: 2,
};
export function drawObject(
  ctx,
  i,
  textColor,
  repaint,
  hideText = false,
  tags,
  shadows = true,
  author = null,
) {
  const flowing = growsWithText(i) ? autoHeightLayout(i, ctx) : null;
  const w = Math.abs(i.w),
    h = flowing?.height ?? Math.abs(i.h),
    fill = i.color || "#f6e7a4";
  ctx.save();
  ctx.translate(i.x, i.y);
  if (rotationOf(i)) {
    ctx.translate(i.w / 2, i.h / 2);
    ctx.rotate((rotationOf(i) * Math.PI) / 180);
    ctx.translate(-i.w / 2, -i.h / 2);
  }
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (i.type === "arrow") {
    const path = connectorPath(i).map((p) => ({ x: p.x - i.x, y: p.y - i.y }));
    ctx.lineWidth = i.lineWidth || 2.5;
    const thickness = ctx.lineWidth;
    ctx.setLineDash(
      i.lineStyle === "dashed"
        ? [thickness * 4, thickness * 3]
        : i.lineStyle === "dotted"
          ? [0.1, thickness * 2.5]
          : [],
    );
    ctx.beginPath();
    ctx.moveTo(0, 0);
    if (i.lineType === "curved")
      ctx.bezierCurveTo(path[1].x, path[1].y, path[2].x, path[2].y, i.w, i.h);
    else path.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.setLineDash([]);
    const cap = (kind, point, neighbor) => {
      for (const part of capParts(kind, point, neighbor, thickness)) {
        ctx.beginPath();
        if (part.type === "circle")
          ctx.arc(part.x, part.y, part.r, 0, Math.PI * 2);
        else {
          part.points.forEach((p, n) =>
            n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
          );
          if (part.closed) ctx.closePath();
        }
        // An open shape is white inside, over the line it ends.
        if (part.fill) {
          ctx.fillStyle = part.fill === "line" ? fill : "#ffffff";
          ctx.fill();
          ctx.fillStyle = fill;
        }
        if (part.stroke) ctx.stroke();
      }
    };
    cap(
      i.startCap || "none",
      path[0],
      path.find((p) => p.x !== path[0].x || p.y !== path[0].y) || path.at(-1),
    );
    cap(
      i.endCap || "arrow",
      path.at(-1),
      [...path].reverse().find((p) => p.x !== i.w || p.y !== i.h) || path[0],
    );
    if (i.text && !hideText) {
      const box = connectorLabel(i),
        style = textStyle(i);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(box.x - i.x, box.y - i.y, box.w, box.h, 4);
      ctx.fill();
      drawObject(
        ctx,
        labelObject(i, {
          ...i,
          type: "connector-label",
          x: box.x - i.x,
          y: box.y - i.y,
          w: box.w,
          h: box.h,
          color: "#ffffff",
          fontSize: style.size,
          textAlign: style.align,
        }),
        textColor,
        repaint,
        false,
      );
    }
  } else if (i.type === "pen") {
    ctx.lineWidth = 3;
    ctx.beginPath();
    i.points.forEach(([x, y], n) => (n ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    if (i.points.length === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (i.type === "table") {
    const rows = i.cells.length,
      cols = i.cells[0].length,
      layout = tableLayout(i),
      align = tableTextAlign(i),
      lineHeight = tableFontSize(i) * 1.35;
    ctx.font = tableFont(i);
    ctx.textBaseline = "top";
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++) {
        const cw = layout.columns[col],
          rh = layout.rows[row],
          x = layout.x[col],
          y = layout.y[row];
        ctx.fillStyle = row === 0 ? "#e6ebdf" : i.color || "#ffffff";
        ctx.fillRect(x, y, cw, rh);
        ctx.strokeStyle = "#a2aaa0";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, cw, rh);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 6, y + 6, Math.max(0, cw - 12), Math.max(0, rh - 12));
        ctx.clip();
        ctx.fillStyle = "#30342f";
        // Lines align within the cell's padding.
        ctx.textAlign = align;
        const left =
          align === "center"
            ? x + cw / 2
            : align === "right"
              ? x + cw - 9
              : x + 9;
        // Lines below the cell are clipped; skip drawing them.
        cachedWrapText(ctx, i.cells[row][col], cw - 18)
          .slice(0, Math.max(0, Math.ceil((rh - 9) / lineHeight)))
          .forEach((line, n) =>
            ctx.fillText(line, left, y + 9 + n * lineHeight),
          );
        ctx.restore();
      }
  } else if (["link", "file"].includes(i.type)) {
    ctx.fillStyle = i.color || "#ffffff";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = "#92998d";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(12, 12, w - 24, h - 24);
    ctx.clip();
    ctx.fillStyle = "#30342f";
    ctx.textBaseline = "top";
    const labelSize = i.fontSize || 18;
    ctx.font = `500 ${labelSize}px ${fontStack(fontFamily(i))}`;
    const lines = cachedWrapText(
      ctx,
      i.text || i.fileName || i.url || "",
      w - 32,
    );
    lines
      .slice(0, 3)
      .forEach((line, n) =>
        ctx.fillText(line, 16, 16 + (n * labelSize * 4) / 3),
      );
    ctx.font = `400 ${(labelSize * 2) / 3}px ${fontStack(fontFamily(i))}`;
    ctx.fillStyle = "#52624b";
    ctx.fillText(
      i.type === "link" ? new URL(i.url).hostname : fileDetails(i),
      16,
      h - 30,
    );
    ctx.restore();
  } else if (i.type === "embed") {
    drawEmbedCard(ctx, i);
  } else if (i.type === "image") {
    const image = imageFor(i.src);
    if (image.image.complete && image.image.naturalWidth) {
      const { source: s, box: b } = imageLayout(
        i,
        image.image.naturalWidth,
        image.image.naturalHeight,
      );
      if (i.crop?.mask === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(
          b.x - i.x + b.w / 2,
          b.y - i.y + b.h / 2,
          b.w / 2,
          b.h / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.clip();
      }
      ctx.drawImage(
        image.image,
        s.x,
        s.y,
        s.w,
        s.h,
        b.x - i.x,
        b.y - i.y,
        b.w,
        b.h,
      );
    } else {
      // Still loading, or failed: a plain plate keeps the object visible
      // and selectable where it is instead of leaving an invisible box.
      ctx.fillStyle = IMAGE_PLACEHOLDER.fill;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = IMAGE_PLACEHOLDER.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      if (repaint && !image.failed)
        image.waiting.set(ctx.canvas || ctx, repaint);
    }
  } else {
    // A border set thicker, dashed or dotted is drawn inside the outline.
    const border = ["rect", "ellipse"].includes(i.type)
      ? shapeBorder(i, w, h)
      : null;
    const inset = border?.inset || 0;
    if (i.type === "rect" && i.shape) drawShape(ctx, i.shape, w, h, i);
    else if (i.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        w / 2,
        h / 2,
        w / 2 - inset,
        h / 2 - inset,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.strokeStyle = SHAPE_COLORS.LINE;
      ctx.lineWidth = border?.width || 1;
      if (border) ctx.setLineDash(border.dash);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (i.type !== "text") {
      ctx.beginPath();
      ctx.roundRect(
        inset,
        inset,
        w - inset * 2,
        h - inset * 2,
        i.type === "note" ? 2 : Math.max(0, 10 - inset),
      );
      if (i.type === "note" && shadows) noteShadow(ctx, () => ctx.fill());
      else if (i.type !== "frame") ctx.fill();
      if (["frame", "rect"].includes(i.type)) {
        ctx.strokeStyle = i.type === "frame" ? "#a2aaa0" : SHAPE_COLORS.LINE;
        ctx.lineWidth = border?.width || 1;
        if (i.type === "frame") ctx.setLineDash([6, 5]);
        else if (border) ctx.setLineDash(border.dash);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    const fitted =
      !hideText && i.autoFontSize && canAutoFitText(i)
        ? fitTextLayout(i, ctx, i.text || "", textColor)
        : null;
    const style = fitted?.style || textStyle(i, textColor);
    const { size, font, align, padding } = style;
    // Over a highlight, text in the theme's ink takes the ink the
    // highlight's own lightness asks for.
    const inkOver = (highlight, s = style) =>
      inkOverHighlight(highlight, s, textColor);
    const color = inkOver(i.highlight);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    const layout =
      fitted || (!hideText && boxedText(i) ? shapeTextLayout(i, ctx) : null);
    const area = layout?.box || { x: 0, y: 0, w, h: h - tagFooter(i) };
    const richLines =
      !hideText && (i.textRuns?.length || i.textBlocks?.length)
        ? flowing?.richLines ||
          layout?.richLines ||
          (i.textBlocks?.length
            ? listTextLayout(
                i,
                ctx,
                Math.max(20, w - padding * 2),
                i.text || "",
                i.textRuns,
                i.textBlocks,
                textColor,
              )
            : richTextLayout(
                i,
                ctx,
                Math.max(20, w - padding * 2),
                i.text || "",
                i.textRuns,
                textColor,
              ))
        : null;
    const lines = richLines
      ? richLines.map((line) => line.text)
      : hideText
        ? []
        : flowing?.lines ||
          layout?.lines ||
          cachedWrapText(ctx, i.text || "", Math.max(20, w - padding * 2));
    const clip = textClip(i, area, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    const widths =
      !richLines && (align !== "left" || i.underline || i.strike || i.highlight)
        ? wrappedLineWidths(ctx, lines, !!flowing)
        : null;
    // Only the lines within the clipped area are drawn: text overflowing a
    // note or a fixed-height box would otherwise cost a draw per hidden line.
    const lineHeight = size * 1.35,
      top = layout?.top ?? padding;
    const first = Math.max(0, Math.floor(-top / lineHeight)),
      last = Math.min(
        lines.length,
        Math.max(first, Math.ceil((area.h - top) / lineHeight)),
      );
    for (let n = first; n < last; n++) {
      const line = lines[n];
      const rich = richLines?.[n];
      const width = rich ? rich.width : widths ? widths[n] : 0;
      const indent = rich?.indent || 0;
      const x =
        align === "center"
          ? indent + (area.w - indent - width) / 2
          : align === "right"
            ? area.w - padding - width
            : padding + indent;
      const y = area.y + top + n * lineHeight;
      if (rich) {
        if (rich.marker) {
          ctx.font = rich.markerStyle.font;
          ctx.fillStyle = rich.markerStyle.autoColor
            ? textColor || "#30342f"
            : rich.markerStyle.color;
          ctx.fillText(
            rich.marker,
            area.x + padding + indent - size * 0.5 - rich.markerWidth,
            y,
          );
        }
        let left = area.x + x;
        for (const part of rich.segments) {
          const style = part.style;
          const partColor = style.highlight
            ? inkOver(style.highlight, style)
            : style.autoLinkColor
              ? linkColor(textColor)
              : style.autoColor
                ? textColor || "#30342f"
                : style.color;
          if (style.highlight) {
            ctx.fillStyle = style.highlight;
            ctx.fillRect(left, y, part.width, size * 1.35);
          }
          ctx.font = style.font;
          ctx.fillStyle = partColor;
          ctx.fillText(part.text, left, y);
          ctx.strokeStyle = partColor;
          ctx.lineWidth = Math.max(1, size / 16);
          for (const offset of [
            style.underline && size * 1.05,
            style.strike && size * 0.55,
          ]) {
            if (!offset) continue;
            ctx.beginPath();
            ctx.moveTo(left, y + offset);
            ctx.lineTo(left + part.width, y + offset);
            ctx.stroke();
          }
          left += part.width;
        }
        continue;
      }
      if (i.highlight) {
        ctx.fillStyle = i.highlight;
        ctx.fillRect(area.x + x, y, width, size * 1.35);
        ctx.fillStyle = color;
      }
      ctx.fillText(line, area.x + x, y);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size / 16);
      for (const offset of [
        i.underline && size * 1.05,
        i.strike && size * 0.55,
      ]) {
        if (!offset) continue;
        ctx.beginPath();
        ctx.moveTo(area.x + x, y + offset);
        ctx.lineTo(area.x + x + width, y + offset);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  if (author && i.type === "note" && !hideText)
    drawAuthor(ctx, w, h - tagFooter(i), author, textStyle(i, textColor).color);
  if (tagFooter(i) && tags) drawTags(ctx, i, tags);
  if (tagFooter(i)) drawTaskBadge(ctx, i);
  ctx.restore();
}
// Who added a sticky note, for people who chose to see it: in the note's
// own ink, quieter, in the padding under its text, so nothing moves.
const authorWidths = new Map();
function drawAuthor(ctx, w, bottom, name, color) {
  const size = Math.min(12, Math.max(9, bottom * 0.055)),
    room = w - 32;
  if (room < 24) return;
  ctx.save();
  ctx.font = `500 ${size}px ${fontStack("dm-sans")}`;
  const key = `${ctx.font}\n${room}\n${name}`;
  let text = authorWidths.get(key);
  if (text === undefined) {
    text = name;
    if (ctx.measureText(text).width > room) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > room)
        text = text.slice(0, -1);
      text += "…";
    }
    if (authorWidths.size > 2000) authorWidths.clear();
    authorWidths.set(key, text);
  }
  ctx.fillStyle = color;
  ctx.globalAlpha *= 0.78;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 16, bottom - 4);
  ctx.restore();
}
// Zoomed out, a frame's own title shrinks below reading size. The main
// canvas then names the frame above its top-left corner at a fixed size,
// as Miro does, so a large board seen whole still shows its sections; a
// press on that name acts on the frame (frameLabelAt).
const FRAME_LABEL_FONT = 12,
  FRAME_LABEL_READABLE = 9;
let frameLabelBoxes = [];
const labelWidths = new Map();
export function frameLabels(items, view, width, height, ctx) {
  const labels = [];
  ctx.save();
  ctx.font = `500 ${FRAME_LABEL_FONT}px ${fontStack("dm-sans")}`;
  const measure = (text) => {
    let w = labelWidths.get(text);
    if (w === undefined) {
      if (labelWidths.size > 5000) labelWidths.clear();
      labelWidths.set(text, (w = ctx.measureText(text).width));
    }
    return w;
  };
  for (const f of items) {
    if (f.type !== "frame") continue;
    if ((f.fontSize || 19) * view.z >= FRAME_LABEL_READABLE) continue;
    const title = (f.text || "").split("\n")[0].trim(),
      x = f.x * view.z + view.x,
      y = f.y * view.z + view.y,
      room = f.w * view.z;
    if (!title || room < 24) continue;
    const h = Math.round(FRAME_LABEL_FONT * 1.5),
      top = y - h - 2;
    if (x + room < 0 || x > width || top + h < 0 || top > height) continue;
    // A long title is cut to the frame's width, as Miro does.
    let text = title;
    if (measure(text) > room) {
      let low = 0,
        high = title.length;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (measure(title.slice(0, mid).trimEnd() + "…") <= room) low = mid;
        else high = mid - 1;
      }
      if (!low) continue;
      text = title.slice(0, low).trimEnd() + "…";
    }
    labels.push({
      id: f.id,
      text,
      x,
      y: top,
      w: measure(text),
      h,
      area: Math.abs(f.w * f.h),
    });
  }
  ctx.restore();
  return clearLabels(labels);
}
// A frame inside another, near its corner, would be named over the outer
// frame's name. The larger frame keeps its name and a name that would
// overlap one already kept is left out until zooming in parts them. Kept
// names are found through a grid of screen cells, so each is compared
// with its few neighbours only.
const LABEL_CELL = 128;
function clearLabels(labels) {
  const shown = (kept) =>
    labels.flatMap(({ area, ...l }, n) => (kept(n) ? [l] : []));
  if (labels.length < 2) return shown(() => true);
  const cells = new Map(),
    kept = new Set();
  const order = labels
    .map((_, n) => n)
    .sort((a, b) => labels[b].area - labels[a].area || a - b);
  for (const n of order) {
    const l = labels[n],
      keys = [];
    for (
      let row = Math.floor(l.y / LABEL_CELL);
      row <= Math.floor((l.y + l.h) / LABEL_CELL);
      row++
    )
      for (
        let col = Math.floor(l.x / LABEL_CELL);
        col <= Math.floor((l.x + l.w) / LABEL_CELL);
        col++
      )
        keys.push(`${row},${col}`);
    const overlaps = keys.some((key) =>
      cells
        .get(key)
        ?.some(
          (o) =>
            l.x < o.x + o.w &&
            o.x < l.x + l.w &&
            l.y < o.y + o.h &&
            o.y < l.y + l.h,
        ),
    );
    if (overlaps) continue;
    kept.add(n);
    for (const key of keys) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(l);
    }
  }
  return shown((n) => kept.has(n));
}
// The frame names last drawn on the main canvas, in canvas pixels.
export function shownFrameLabels() {
  return frameLabelBoxes;
}
// The frame whose name, drawn above it zoomed out, is at this screen point.
export function frameLabelAt(x, y) {
  for (let n = frameLabelBoxes.length - 1; n >= 0; n--) {
    const l = frameLabelBoxes[n];
    if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l.id;
  }
  return null;
}
export function paint(canvas, items, view, options = {}) {
  const tags = tagCatalog(options.tags);
  const counts =
    options.mindBadges === false
      ? null
      : options.mindCounts || mindVisibility(items, options.comments).counts;
  items = visibleMindItems(items);
  const rect = canvas.getBoundingClientRect();
  const width = options.width || rect.width || 300,
    height = options.height || rect.height || 150;
  const dpr = options.dpr || Math.min(window.devicePixelRatio || 1, 2);
  const pixelW = Math.max(1, Math.round(width * dpr)),
    pixelH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelW) canvas.width = pixelW;
  if (canvas.height !== pixelH) canvas.height = pixelH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (reflowTextItems(items, ctx)) {
    // The list may be part of a board, as when the facilitator hides objects
    // or a frame is presented. A connector to an object outside it keeps its
    // attachment; only lines whose ends are all here follow the reflow.
    const ids = new Set(items.map((i) => i.id));
    updateConnectors(
      items.filter(
        (i) =>
          i.type !== "arrow" ||
          ((!i.startId || ids.has(i.startId)) &&
            (!i.endId || ids.has(i.endId))),
      ),
    );
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const style = getComputedStyle(document.documentElement);
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (options.grid) {
    drawGrid(
      ctx,
      view,
      width,
      height,
      options.grid === true ? "dots" : options.grid,
      style.getPropertyValue("--dot").trim() || "#d6ddd2",
    );
  }
  ctx.translate(view.x, view.y);
  ctx.scale(view.z, view.z);
  const repaint = () => {
    if (canvas.isConnected) {
      if (options.repaint) options.repaint();
      else paint(canvas, items, view, options);
    }
  };
  if (document.fonts?.load) {
    let state = canvasFonts.get(canvas);
    if (!state) canvasFonts.set(canvas, (state = { families: new Set() }));
    state.repaint = repaint;
    const needed = [...itemFontFamilies(items)].filter(
      (id) => !state.families.has(id) && !fontWaits(id),
    );
    if (needed.length) {
      needed.forEach((id) => state.families.add(id));
      // Families already loaded for another canvas, as a board's for its
      // library card, were measured with their real metrics: nothing is
      // cleared or painted again for them.
      if (needed.some((id) => !fontFamilyReady(id)))
        Promise.all(needed.map((id) => loadFontFamily(id)))
          .then(() => {
            refreshTextLayouts();
            state.repaint();
          })
          .catch(() => {
            // Asked for again on a later paint, once the wait is over.
            needed.forEach((id) => state.families.delete(id));
            fontFailed(needed.filter((id) => !fontFamilyReady(id)));
          });
    }
  }
  const visible = (b) =>
    !(
      (b.x + b.w) * view.z + view.x < -30 ||
      b.x * view.z + view.x > width + 30 ||
      (b.y + b.h) * view.z + view.y < -30 ||
      b.y * view.z + view.y > height + 30
    );
  for (const line of mindLines(items)) {
    if (visible(bounds([line]))) drawObject(ctx, line, "#30342f", repaint);
  }
  const textColor =
    options.textColor || style.getPropertyValue("--text").trim() || "#30342f";
  // Zoomed far out, text a few pixels tall is left out, as Miro does: it
  // cannot be read, and a whole large board in view would set every line.
  const coarse = options.coarse && view.z < DETAIL_ZOOM;
  const textSize = (i) =>
    (i.fontSize || (i.type === "text" ? 28 : i.type === "arrow" ? 16 : 19)) *
    view.z;
  const unreadable = (i) => textSize(i) < 4;
  // Text less than a pixel tall shows no letters, only a faint tint. A
  // library preview leaves it out: a large board's preview laid out every
  // line of thousands of notes for it, more than once while fonts loaded.
  const speck = (i) => options.tinyText === false && textSize(i) * dpr < 1;
  // Zoomed far out, an unrotated sticky note or plain rectangle a few
  // pixels across is a block of its colour: its corners, border and text
  // cannot be seen, and a large board seen whole has thousands of them.
  // Up to 12 pixels across, so is one, or an ellipse, whose shadow would be
  // under a pixel and whose text and tags are not shown, with its outline.
  const block = (i, b) => {
    if (!coarse || rotationOf(i)) return false;
    if (i.type !== "note" && i.type !== "ellipse" && i.type !== "rect")
      return false;
    if (i.type === "rect" && i.shape) return false;
    const across = Math.max(b.w, b.h) * view.z;
    if (across < 6 && i.type !== "ellipse") return true;
    return (
      across < 12 &&
      view.z * dpr * NOTE_SHADOW.blur < 1 &&
      (!i.text || unreadable(i)) &&
      !tagFooter(i)
    );
  };
  // A frame whose title is being typed shows it in the editor instead.
  const labels = options.frameLabels
    ? frameLabels(items, view, width, height, ctx).filter(
        (l) => l.id !== options.editingId,
      )
    : [];
  if (options.frameLabels) frameLabelBoxes = labels;
  const labelled = new Set(labels.map((l) => l.id));
  for (const i of stackedItems(items)) {
    if (i.id === options.cropId) continue;
    const b = bounds([i]);
    if (!visible(b)) continue;
    if (options.searchMatches)
      ctx.globalAlpha = options.searchMatches.has(i.id) ? 1 : 0.25;
    if (block(i, b)) {
      const w = Math.abs(i.w),
        h = Math.abs(i.h);
      ctx.fillStyle = i.color || "#f6e7a4";
      if (
        i.type === "note" ||
        (i.type === "rect" && Math.max(b.w, b.h) * view.z < 6)
      )
        ctx.fillRect(i.x, i.y, w, h);
      else {
        ctx.beginPath();
        if (i.type === "ellipse")
          ctx.ellipse(
            i.x + w / 2,
            i.y + h / 2,
            w / 2,
            h / 2,
            0,
            0,
            Math.PI * 2,
          );
        else ctx.roundRect(i.x, i.y, w, h, 10);
        ctx.fill();
        // Its outline, though a fraction of a pixel, still sets a white
        // shape apart from the board.
        ctx.strokeStyle = SHAPE_COLORS.LINE;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      continue;
    }
    drawObject(
      ctx,
      i,
      textColor,
      repaint,
      options.editingId === i.id ||
        (coarse && unreadable(i)) ||
        speck(i) ||
        labelled.has(i.id),
      tags,
      options.shadows !== false,
      options.authors?.get(i.id),
    );
  }
  if (labels.length) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `500 ${FRAME_LABEL_FONT}px ${fontStack("dm-sans")}`;
    ctx.fillStyle = textColor;
    ctx.textBaseline = "middle";
    for (const l of labels) {
      ctx.globalAlpha =
        options.searchMatches && !options.searchMatches.has(l.id) ? 0.25 : 1;
      ctx.fillText(l.text, l.x, l.y + l.h / 2);
    }
    ctx.restore();
  }
  if (counts?.size) {
    ctx.save();
    ctx.globalAlpha = 1;
    for (const i of items) {
      const count = counts.get(i.id);
      if (!count || !visible(i)) continue;
      const x = i.x + i.w,
        y = i.y;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#0869d6";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#0869d6";
      ctx.font = "600 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(count.total), x, y, 25);
    }
    ctx.restore();
  }
  if (options.quickPreview) {
    const { node, line, target, existing } = options.quickPreview;
    ctx.save();
    ctx.globalAlpha = 0.5;
    const accent = style.getPropertyValue("--accent").trim() || "#0869d6";
    if (!existing)
      drawObject(
        ctx,
        { ...line, color: accent, lineStyle: "dashed" },
        "#30342f",
        repaint,
      );
    if (node) drawObject(ctx, node, "#30342f", repaint);
    else {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3 / view.z;
      ctx.strokeRect(
        target.x - 4 / view.z,
        target.y - 4 / view.z,
        target.w + 8 / view.z,
        target.h + 8 / view.z,
      );
    }
    ctx.restore();
  }
  if (options.searchMatches) {
    ctx.globalAlpha = 1;
    ctx.save();
    for (const i of items) {
      if (!options.searchMatches.has(i.id)) continue;
      const b = bounds([i]);
      if (!visible(b)) continue;
      ctx.strokeStyle = i.id === options.searchActive ? "#d36b13" : "#587ac6";
      ctx.lineWidth = (i.id === options.searchActive ? 3 : 1.5) / view.z;
      ctx.strokeRect(
        b.x - 5 / view.z,
        b.y - 5 / view.z,
        b.w + 10 / view.z,
        b.h + 10 / view.z,
      );
    }
    ctx.restore();
  }
  ctx.strokeStyle = style.getPropertyValue("--accent").trim() || "#0869d6";
  ctx.lineWidth = 1.5 / view.z;
  // A frame the dragged objects will join is outlined and tinted.
  if (options.dropFrames?.size) {
    ctx.save();
    for (const f of items) {
      if (!options.dropFrames.has(f.id)) continue;
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5 / view.z;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
    }
    ctx.restore();
  }
  if (options.groupFocus) {
    const members = items.filter((i) => i.groupId === options.groupFocus);
    if (members.length) {
      const b = bounds(members),
        pad = 10 / view.z;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1 / view.z;
      ctx.setLineDash([5 / view.z, 4 / view.z]);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
  }
  // A single line being edited shows its two end handles instead of a box.
  const lineHandles =
    options.selection?.size === 1 &&
    !options.selectionLocked &&
    !options.endpointsDisabled;
  if (options.selection?.size) {
    const dash = options.selectionLocked ? [5 / view.z, 4 / view.z] : [];
    for (const i of items) {
      if (!options.selection.has(i.id)) continue;
      if (lineHandles && i.type === "arrow") continue;
      // An outline outside the view is not drawn: with everything on a
      // large board selected, each pan would otherwise stroke thousands.
      const angle = rotationOf(i);
      if (!visible(angle ? objectBounds(i, angle) : bounds([i]))) continue;
      const b = angle ? i : bounds([i]);
      ctx.save();
      if (angle) {
        ctx.translate(i.x + i.w / 2, i.y + i.h / 2);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.translate(-i.x - i.w / 2, -i.y - i.h / 2);
      }
      ctx.setLineDash(dash);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.restore();
    }
  }
  const resizeBox =
    options.resizeBox === undefined
      ? resizeBounds(items, options.selection || new Set())
      : options.resizeBox;
  if (resizeBox && !options.selectionLocked) {
    const b = resizeBox;
    if (options.selection?.size > 1)
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    // A round handle at each corner, and a bar along each side that
    // resizes on its own, as in Miro; each turns with a rotated object.
    const s = 11 / view.z,
      long = 18 / view.z,
      thin = 6 / view.z;
    ctx.fillStyle = "#fff";
    for (const handle of [
      "nw",
      "ne",
      "sw",
      "se",
      ...(options.resizeSides || []),
    ]) {
      const [fx, fy] = RESIZE_HANDLES[handle];
      const at = boxPoint(b, { x: b.x + fx * b.w, y: b.y + fy * b.h });
      const [w, h] =
        handle.length === 2 ? [s, s] : fx === 0.5 ? [long, thin] : [thin, long];
      ctx.save();
      ctx.translate(at.x, at.y);
      if (b.rotation) ctx.rotate((b.rotation * Math.PI) / 180);
      ctx.beginPath();
      ctx.roundRect(
        -w / 2,
        -h / 2,
        w,
        h,
        handle.length === 2 ? s / 2 : thin / 2,
      );
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  const rotating =
    !options.selectionLocked &&
    !options.rotationDisabled &&
    (options.rotationBox || rotationBox(items, options.selection || new Set()));
  if (rotating) {
    const p = rotationHandle(rotating, view.z),
      r = 10 / view.z;
    ctx.save();
    ctx.fillStyle = "#fff";
    if (options.rotationBox && options.selection?.size > 1) {
      ctx.save();
      ctx.translate(rotating.x + rotating.w / 2, rotating.y + rotating.h / 2);
      ctx.rotate(((rotating.rotation || 0) * Math.PI) / 180);
      ctx.strokeRect(
        -rotating.w / 2 - 4,
        -rotating.h / 2 - 4,
        rotating.w + 8,
        rotating.h + 8,
      );
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 / view.z, 0.4, 5.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x + 2 / view.z, p.y - 6 / view.z);
    ctx.lineTo(p.x + 4 / view.z, p.y - 3 / view.z);
    ctx.lineTo(p.x + 0 / view.z, p.y - 3 / view.z);
    ctx.stroke();
    if (options.rotationAngle !== undefined) {
      const label = `${Math.round(options.rotationAngle * 10) / 10}°`;
      ctx.font = `500 ${12 / view.z}px sans-serif`;
      const width = ctx.measureText(label).width;
      // The panel color, not white: the label is in the accent color, which
      // is light in the dark theme.
      ctx.fillStyle = style.getPropertyValue("--surface").trim() || "#fff";
      ctx.fillRect(
        p.x + 16 / view.z,
        p.y - 12 / view.z,
        width + 12 / view.z,
        24 / view.z,
      );
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, p.x + 22 / view.z, p.y);
    }
    ctx.restore();
  }
  if (lineHandles) {
    const line = items.find(
      (i) => options.selection.has(i.id) && i.type === "arrow",
    );
    if (line)
      for (const p of [
        { x: line.x, y: line.y },
        { x: line.x + line.w, y: line.y + line.h },
      ]) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / view.z, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
  }
  if (options.connectorTarget) {
    const target = items.find((i) => i.id === options.connectorTarget);
    const i = target && objectBounds(target);
    if (i) {
      ctx.lineWidth = 3 / view.z;
      ctx.strokeRect(
        i.x - 4 / view.z,
        i.y - 4 / view.z,
        i.w + 8 / view.z,
        i.h + 8 / view.z,
      );
    }
  }
  if (options.guides?.length) {
    ctx.save();
    ctx.strokeStyle =
      style.getPropertyValue("--snap-guide").trim() || "#aa3d9b";
    ctx.lineWidth = 1 / view.z;
    ctx.setLineDash([4 / view.z, 3 / view.z]);
    const pad = 10 / view.z;
    for (const guide of options.guides) {
      if (["spacing", "dimension"].includes(guide.kind)) {
        // Spacing axes describe the measured direction; alignment guides run
        // perpendicular to their snap axis.
        ctx.setLineDash([]);
        const horizontal = guide.axis === "x",
          tick = 4 / view.z;
        const point = (along, across) =>
          horizontal ? [along, across] : [across, along];
        ctx.beginPath();
        ctx.moveTo(...point(guide.from, guide.position));
        ctx.lineTo(...point(guide.to, guide.position));
        for (const edge of [guide.from, guide.to]) {
          ctx.moveTo(...point(edge, guide.position - tick));
          ctx.lineTo(...point(edge, guide.position + tick));
        }
        ctx.stroke();
        const label = String(Math.round((guide.gap ?? guide.size) * 10) / 10);
        ctx.font = `500 ${11 / view.z}px "DM Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const width = ctx.measureText(label).width;
        if (
          (guide.to - guide.from) * view.z >
          (horizontal ? width * view.z : 11) + 12
        ) {
          const [x, y] = point((guide.from + guide.to) / 2, guide.position);
          ctx.fillStyle =
            style.getPropertyValue("--surface").trim() || "#ffffff";
          ctx.fillRect(
            x - width / 2 - 3 / view.z,
            y - 7 / view.z,
            width + 6 / view.z,
            14 / view.z,
          );
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(label, x, y);
        }
        continue;
      }
      ctx.setLineDash([4 / view.z, 3 / view.z]);
      ctx.beginPath();
      if (guide.axis === "x") {
        ctx.moveTo(guide.position, guide.from - pad);
        ctx.lineTo(guide.position, guide.to + pad);
      } else {
        ctx.moveTo(guide.from - pad, guide.position);
        ctx.lineTo(guide.to + pad, guide.position);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  if (options.marquee) {
    const b = options.marquee;
    ctx.save();
    ctx.setLineDash(b.precise === false ? [6 / view.z, 4 / view.z] : []);
    ctx.fillStyle = "#879b6c22";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}
// The markup of a board's preview. Art that keeps its own light background
// in every theme names its `ink`, so its text stays legible in the dark
// theme instead of taking the theme's text colour.
export function preview(b, { ink } = {}) {
  previews.set(b.id, b);
  return `<canvas data-preview="${escape(b.id)}"${ink ? ` data-ink="${escape(ink)}"` : ""} aria-hidden="true"></canvas>`;
}
// Pixels kept clear around a board in its library preview: 15 on a card,
// less in the list view's small thumbnail, which it would otherwise fill.
const PREVIEW_INSET = 15;
const previewInset = (width, height) =>
  Math.min(PREVIEW_INSET, Math.round(Math.min(width, height) * 0.1));
// Library previews are painted as their cards come into view: a library of
// hundreds of boards shows a handful at a time, and painting every one on
// load, on each resize and on each return from a board froze the page.
let previewObserver = null;
const nearView = (rect) =>
  rect.bottom >= -400 &&
  rect.top <= (window.innerHeight || 0) + 400 &&
  rect.right >= -400 &&
  rect.left <= (window.innerWidth || 0) + 400;
function paintPreview(canvas, rect = canvas.getBoundingClientRect()) {
  const b = previews.get(canvas.dataset.preview);
  if (!b || !canvas.isConnected) return;
  const theme = document.documentElement.dataset.theme || "";
  const width = rect.width || 300,
    height = rect.height || 150;
  // A picture of the board as last saved, at this size, in this theme and
  // with these fonts stays: the library renders again on each keystroke
  // of a search, and its cards keep their painted canvases.
  const painted = `${b.updated}|${width}x${height}|${theme}|${textLayoutVersion()}|${devicePixelRatio}`;
  if (canvas.dataset.painted === painted) return;
  if (reflowTextItems(b.items, canvas.getContext("2d")))
    updateConnectors(b.items);
  // The bitmap fills its element; a margin inside it keeps the board
  // clear of the card's edges. Padding on the element would display the
  // bitmap in a smaller box than it was sized for and squash the board.
  const a = bounds(visibleMindItems(b.items)),
    inset = previewInset(width, height),
    z = Math.min(
      (width - 2 * inset) / (a.w + 110),
      (height - 2 * inset) / (a.h + 110),
    );
  paint(
    canvas,
    b.items,
    {
      x: width / 2 - (a.x + a.w / 2) * z,
      y: height / 2 - (a.y + a.h / 2) * z,
      z,
    },
    {
      comments: b.comments,
      tags: b.tags,
      textColor: canvas.dataset.ink,
      tinyText: false,
      // Painted again through here once its fonts or pictures load, so
      // the picture is noted as painted with those fonts: the library's
      // own repaint for a font load then finds it painted already.
      repaint: () => {
        delete canvas.dataset.painted;
        paintPreview(canvas);
      },
    },
  );
  canvas.dataset.painted = painted;
}
// A board named in the page's address opens over the library at once; the
// library's previews wait meanwhile, unseen, rather than taking a second
// or more of a library of large boards before the board shows.
let previewsHeld = false;
export function holdPreviews(held) {
  const released = previewsHeld && !held;
  previewsHeld = held;
  if (released) paintPreviews();
}
export function paintPreviews() {
  if (previewsHeld) return;
  const active = new Set();
  const Observer = window.IntersectionObserver;
  // Cards replaced since the last pass are let go.
  previewObserver?.disconnect();
  // Made only once a card is out of view, as most libraries fit on screen.
  const observer = () =>
    (previewObserver ??= new Observer(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            previewObserver.unobserve(entry.target);
            paintPreview(entry.target);
          }
      },
      { rootMargin: "400px" },
    ));
  document.querySelectorAll("canvas[data-preview]").forEach((canvas) => {
    const b = previews.get(canvas.dataset.preview);
    if (!b) return;
    active.add(b.id);
    const rect = canvas.getBoundingClientRect();
    // What is on screen, or nearly, is painted now so nothing flickers.
    if (!Observer || nearView(rect)) paintPreview(canvas, rect);
    else observer().observe(canvas);
  });
  for (const id of previews.keys()) if (!active.has(id)) previews.delete(id);
}
export async function rasterRegion(b, region, options = {}) {
  const counts =
    options.mindCounts || mindVisibility(b.items, b.comments).counts;
  b = { ...b, items: visibleMindItems(b.items) };
  await loadItemFonts(b.items);
  await document.fonts?.ready;
  clearTextLayoutCache();
  clearTagLayouts();
  clearConnectorLabelCache();
  // An image that cannot be decoded is left blank, as on the canvas.
  await Promise.allSettled(
    b.items.filter((i) => i.type === "image").map((i) => imageFor(i.src).ready),
  );
  const canvas = document.createElement("canvas");
  if (reflowTextItems(b.items, canvas.getContext("2d")))
    updateConnectors(b.items);
  const a = region || bounds(b.items),
    padding = region ? 0 : (options.padding ?? 50);
  let scale = Math.min(
    options.scale || 2,
    // Rasters are capped at 4,096 pixels on the longest side unless asked
    // for more, which stays within mobile canvas limits; an area limit
    // bounds a larger side.
    (options.maxSize || 4096) / (Math.max(a.w, a.h) + padding * 2),
    Math.sqrt(
      (options.maxArea || Infinity) /
        ((a.w + padding * 2) * (a.h + padding * 2)),
    ),
  );
  const side = (length) =>
    Math.max(1, Math.ceil((length + padding * 2) * scale));
  // Whole pixels round up, which must not take the image past its area.
  while (options.maxArea && side(a.w) * side(a.h) > options.maxArea)
    scale *= 0.999;
  const width = side(a.w),
    height = side(a.h);
  paint(
    canvas,
    b.items,
    { x: (padding - a.x) * scale, y: (padding - a.y) * scale, z: scale },
    {
      width,
      height,
      dpr: 1,
      // Vector PDF places single rasterized objects over other content,
      // which is drawn without shadows, and trims them to their bounds.
      background: options.transparent ? null : "#ffffff",
      shadows: !options.transparent,
      textColor: "#30342f",
      mindCounts: counts,
      tags: b.tags,
    },
  );
  return canvas;
}
// PNG and JPEG exports keep large boards legible: up to 64 megapixels and
// 16,384 pixels a side on computers, and 16.7 megapixels, the limit of
// iPhone and iPad canvases, on touch screens. A browser that cannot make
// a canvas that large gets the 4,096-pixel image instead.
export const IMAGE_LIMITS = [
  { maxSize: 16384, maxArea: 64e6 },
  { maxSize: 16384, maxArea: 4096 * 4096 },
  { maxSize: 4096 },
];
export async function exportImage(b, region, format = "png", options = {}) {
  const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches,
    limits = options.limits || IMAGE_LIMITS.slice(coarse ? 1 : 0);
  for (let n = 0; ; n++) {
    let blob = null;
    try {
      const canvas = await rasterRegion(b, region, {
        ...options,
        ...limits[n],
      });
      blob = await new Promise((resolve) =>
        canvas.toBlob(
          resolve,
          format === "jpeg" ? "image/jpeg" : "image/png",
          0.95,
        ),
      );
    } catch (error) {
      if (n === limits.length - 1) throw error;
    }
    if (blob) return blob;
    if (n === limits.length - 1) throw Error("Could not export this board.");
  }
}
export const exportPNG = (b) => exportImage(b);
