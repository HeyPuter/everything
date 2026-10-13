import { capParts } from "./connector-caps.js";
import { tableCellContent } from "./table-language.js";
import { sliceTextRuns, textSegments } from "./rich-text.js";
import { rotationOf } from "./geometry.js";
import { stackedItems, imageSize } from "./model.js";
import { mindLines } from "./mind-map.js";
import { visibleMindItems } from "./mind-visibility.js";
import { tableLayout } from "./table-layout.js";
import { tableFont, tableFontSize, tableTextAlign } from "./table-sizing.js";
import { tagFooter } from "./tags.js";
import { fontFamily, fontStack } from "./fonts.js";
import { linkColor, inkOver } from "./text-link-data.js";
import { connectorPath, connectorLabel } from "./connectors.js";
import { imageLayout } from "./image-crop.js";
import { SHAPE_COLORS, shapeBorder } from "./shape-specs.js";
import {
  textStyle,
  richTextLayout,
  listTextLayout,
  cachedWrapText,
  shapeTextLayout,
  boxedText,
  textClip,
  fitTextLayout,
  canAutoFitText,
  growsWithText,
  autoHeightLayout,
} from "./text.js";

// Vector exports (SVG and vector PDF) reuse the canvas renderer's text and
// shape layout so line breaks, fitted sizes and positions match the board.
export const num = (value) => {
  const n = Math.round(value * 100) / 100;
  return Object.is(n, -0) ? "0" : String(n);
};

// Records the canvas path API as SVG path data, so shapes.js geometry drives
// SVG and PDF output without a second description of each silhouette.
export class PathBuilder {
  constructor() {
    this.d = "";
    this.strokes = [];
    this.current = null;
    this.start = null;
  }
  beginPath() {
    this.d = "";
    this.current = this.start = null;
  }
  moveTo(x, y) {
    this.d += `M${num(x)} ${num(y)}`;
    this.current = this.start = { x, y };
  }
  lineTo(x, y) {
    if (!this.current) return this.moveTo(x, y);
    this.d += `L${num(x)} ${num(y)}`;
    this.current = { x, y };
  }
  bezierCurveTo(ax, ay, bx, by, x, y) {
    if (!this.current) this.moveTo(ax, ay);
    this.d += `C${num(ax)} ${num(ay)} ${num(bx)} ${num(by)} ${num(x)} ${num(y)}`;
    this.current = { x, y };
  }
  closePath() {
    if (!this.current) return;
    this.d += "Z";
    this.current = this.start;
  }
  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.d += `H${num(x + w)}V${num(y + h)}H${num(x)}Z`;
    this.current = this.start;
  }
  roundRect(x, y, w, h, radius = 0) {
    // Canvas scales radii down when they exceed half of a side.
    const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
    if (!r) return this.rect(x, y, w, h);
    const arc = (ex, ey) => `A${num(r)} ${num(r)} 0 0 1 ${num(ex)} ${num(ey)}`;
    this.moveTo(x + r, y);
    this.d +=
      `H${num(x + w - r)}${arc(x + w, y + r)}V${num(y + h - r)}` +
      `${arc(x + w - r, y + h)}H${num(x + r)}${arc(x, y + h - r)}` +
      `V${num(y + r)}${arc(x + r, y)}Z`;
    this.current = this.start;
  }
  arc(x, y, r, start, end, ccw = false) {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }
  ellipse(cx, cy, rx, ry, rotation, start, end, ccw = false) {
    const cos = Math.cos(rotation),
      sin = Math.sin(rotation);
    const point = (a) => ({
      x: cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin,
      y: cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos,
    });
    const tau = Math.PI * 2,
      span = ccw ? start - end : end - start;
    const full = span >= tau - 1e-9;
    const amount = full ? tau : ((span % tau) + tau) % tau;
    const from = point(start);
    if (this.current) this.lineTo(from.x, from.y);
    else this.moveTo(from.x, from.y);
    if (!rx || !ry || !amount) return;
    const sweep = ccw ? 0 : 1,
      degrees = num((rotation * 180) / Math.PI),
      arc = (p, large) =>
        `A${num(rx)} ${num(ry)} ${degrees} ${large} ${sweep} ${num(p.x)} ${num(p.y)}`;
    if (full) {
      const half = point(start + (ccw ? -Math.PI : Math.PI));
      this.d += arc(half, 0) + arc(from, 0);
      this.current = from;
      return;
    }
    const to = point(ccw ? start - amount : start + amount);
    this.d += arc(to, amount > Math.PI ? 1 : 0);
    this.current = to;
  }
  fill() {}
  stroke() {
    this.strokes.push(this.d);
  }
}

// A long export gives the page a turn every so often, between pages or
// slides, so its progress shows and closing the dialog can cancel it.
let turn = 0;
export async function breathe() {
  const now = globalThis.performance?.now() ?? Date.now();
  if (now - turn < 50) return;
  // scheduler.yield resumes ahead of other tasks, without the 4 ms that
  // repeated timers take.
  await (globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0)));
  turn = globalThis.performance?.now() ?? Date.now();
}
// A fresh measuring context per export; text layout caches are keyed by it.
export function measureContext() {
  const ctx = globalThis.document?.createElement("canvas").getContext?.("2d");
  if (ctx) return ctx;
  // Approximate metrics keep exports usable where Canvas is unavailable.
  let font = "400 16px sans-serif";
  return {
    get font() {
      return font;
    },
    set font(value) {
      font = value;
    },
    textBaseline: "top",
    measureText(text) {
      const size = +(/([\d.]+)px/.exec(font)?.[1] || 16);
      return { width: Array.from(String(text)).length * size * 0.55 };
    },
  };
}

// Distance from the canvas "top" or "middle" baseline to the alphabetic
// baseline, measured with the real font so SVG text lands where canvas draws.
const baselines = new WeakMap();
export function baselineOffset(ctx, font, baseline = "top") {
  let cache = baselines.get(ctx);
  if (!cache) baselines.set(ctx, (cache = new Map()));
  const key = `${baseline}\n${font}`;
  if (cache.has(key)) return cache.get(key);
  const size = +(/([\d.]+)px/.exec(font)?.[1] || 16),
    previous = ctx.textBaseline;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const alphabetic = ctx.measureText("H").actualBoundingBoxAscent;
  ctx.textBaseline = baseline;
  const other = ctx.measureText("H").actualBoundingBoxAscent;
  ctx.textBaseline = previous;
  let offset = alphabetic - other;
  if (!Number.isFinite(offset) || offset <= 0 || offset > size * 1.5)
    offset = size * (baseline === "top" ? 0.8 : 0.34);
  cache.set(key, offset);
  return offset;
}

// Mind map lines draw first, frames stay behind content: the paint() order.
export function drawOrder(items) {
  const visible = visibleMindItems(items);
  return [...mindLines(visible), ...stackedItems(visible)];
}

export function objectFrame(i) {
  const rotation = rotationOf(i);
  return { x: i.x, y: i.y, rotation, cx: i.w / 2, cy: i.h / 2 };
}

const fontOf = (style) => ({
  lang: style.lang,
  font: style.font,
  family: style.family,
  size: style.size,
  bold: !!style.bold,
  italic: !!style.italic,
});

// Mirrors the text branch of drawObject(): returns positioned lines in
// object-local coordinates, each split into styled parts.
export function textBlock(i, ctx, textColor = "#30342f") {
  const flowing = growsWithText(i) ? autoHeightLayout(i, ctx) : null;
  const w = Math.abs(i.w),
    h = flowing?.height ?? Math.abs(i.h);
  const fitted =
    i.autoFontSize && canAutoFitText(i)
      ? fitTextLayout(i, ctx, i.text || "", textColor)
      : null;
  const style = fitted?.style || textStyle(i, textColor);
  const { size, font, align, padding } = style;
  ctx.font = font;
  const layout = fitted || (boxedText(i) ? shapeTextLayout(i, ctx) : null);
  const area = layout?.box || { x: 0, y: 0, w, h: h - tagFooter(i) };
  const richLines =
    i.textRuns?.length || i.textBlocks?.length
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
  ctx.font = font;
  const lines = richLines
    ? richLines.map((line) => line.text)
    : flowing?.lines ||
      layout?.lines ||
      cachedWrapText(ctx, i.text || "", Math.max(20, w - padding * 2));
  const result = { clip: textClip(i, area, size), size, lines: [] };
  lines.forEach((line, n) => {
    const rich = richLines?.[n];
    ctx.font = font;
    const width = rich
      ? rich.width
      : ctx.measureText(flowing ? line.replace(/ +$/, "") : line).width;
    const indent = rich?.indent || 0;
    const x =
      align === "center"
        ? indent + (area.w - indent - width) / 2
        : align === "right"
          ? area.w - padding - width
          : padding + indent;
    const y = area.y + (layout?.top ?? padding) + n * size * 1.35;
    const entry = { y, size, parts: [] };
    if (rich) {
      if (rich.marker)
        entry.marker = {
          text: rich.marker,
          x: area.x + padding + indent - size * 0.5 - rich.markerWidth,
          width: rich.markerWidth,
          style: {
            ...fontOf(rich.markerStyle),
            color: rich.markerStyle.autoColor
              ? textColor || "#30342f"
              : rich.markerStyle.color,
          },
        };
      let left = area.x + x;
      for (const part of rich.segments) {
        const s = part.style;
        entry.parts.push({
          text: part.text,
          x: left,
          width: part.width,
          style: {
            ...fontOf(s),
            // Over a highlight, as on the board, text in the theme's ink
            // takes the ink the highlight's lightness asks for.
            color: s.highlight
              ? inkOver(s.highlight, s, textColor)
              : s.autoLinkColor
                ? linkColor(textColor)
                : s.autoColor
                  ? textColor || "#30342f"
                  : s.color,
            highlight: s.highlight || null,
            underline: !!s.underline,
            strike: !!s.strike,
          },
        });
        left += part.width;
      }
    } else
      entry.parts.push({
        text: line,
        x: area.x + x,
        width,
        style: {
          ...fontOf(style),
          color: inkOver(i.highlight, style, textColor),
          highlight: i.highlight || null,
          underline: !!i.underline,
          strike: !!i.strike,
        },
      });
    result.lines.push(entry);
  });
  return result;
}

// Connector geometry in board coordinates, matching the canvas stroke, caps
// and label box.
export function connectorShape(i) {
  const path = connectorPath(i),
    thickness = i.lineWidth || 2.5,
    color = i.color || "#f6e7a4";
  const line = new PathBuilder();
  line.moveTo(path[0].x, path[0].y);
  if (i.lineType === "curved")
    line.bezierCurveTo(
      path[1].x,
      path[1].y,
      path[2].x,
      path[2].y,
      i.x + i.w,
      i.y + i.h,
    );
  else path.slice(1).forEach((p) => line.lineTo(p.x, p.y));
  const end = { x: i.x + i.w, y: i.y + i.h };
  // Each part of an end as a path, with its fill (the line's color, white
  // inside an open shape, or none) and whether its outline is drawn.
  const caps = [];
  const cap = (kind, point, neighbor) => {
    for (const part of capParts(kind, point, neighbor, thickness)) {
      const path = new PathBuilder();
      if (part.type === "circle")
        path.arc(part.x, part.y, part.r, 0, Math.PI * 2);
      else {
        part.points.forEach((p, n) =>
          n ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y),
        );
        if (part.closed) path.closePath();
      }
      caps.push({
        kind,
        d: path.d,
        fill: part.fill === "line" ? color : part.fill ? "#ffffff" : null,
        stroke: part.stroke,
      });
    }
  };
  cap(
    i.startCap || "none",
    path[0],
    path.find((p) => p.x !== path[0].x || p.y !== path[0].y) || path.at(-1),
  );
  cap(
    i.endCap || "arrow",
    end,
    [...path].reverse().find((p) => p.x !== end.x || p.y !== end.y) || path[0],
  );
  let label = null;
  if (i.text) {
    const box = connectorLabel(i),
      style = textStyle(i);
    label = {
      box,
      item: {
        ...i,
        type: "connector-label",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        color: "#ffffff",
        fontSize: style.size,
        textAlign: style.align,
      },
    };
  }
  return {
    d: line.d,
    color,
    width: thickness,
    dash:
      i.lineStyle === "dashed"
        ? [thickness * 4, thickness * 3]
        : i.lineStyle === "dotted"
          ? [0.1, thickness * 2.5]
          : [],
    caps,
    label,
  };
}

// Background silhouette for notes, shapes, ellipses and frames, in local
// coordinates, or null for plain text. A shape's border set thicker, dashed
// or dotted is drawn inside its outline, as on the board.
export function objectOutline(i, h = Math.abs(i.h)) {
  const w = Math.abs(i.w),
    path = new PathBuilder();
  if (i.type === "rect" && i.shape) return null;
  const border = ["rect", "ellipse"].includes(i.type)
    ? shapeBorder(i, w, h)
    : null;
  const inset = border?.inset || 0,
    width = border?.width || 1;
  if (i.type === "ellipse") {
    path.ellipse(w / 2, h / 2, w / 2 - inset, h / 2 - inset, 0, 0, Math.PI * 2);
    return {
      d: path.d,
      fill: true,
      stroke: SHAPE_COLORS.LINE,
      width,
      dash: border?.dash || [],
    };
  }
  if (i.type === "text") return null;
  path.roundRect(
    inset,
    inset,
    w - inset * 2,
    h - inset * 2,
    i.type === "note" ? 2 : Math.max(0, 10 - inset),
  );
  return {
    d: path.d,
    fill: i.type !== "frame",
    stroke:
      i.type === "frame"
        ? "#a2aaa0"
        : i.type === "rect"
          ? SHAPE_COLORS.LINE
          : null,
    width,
    dash: i.type === "frame" ? [6, 5] : border?.dash || [],
  };
}

export function cardLayout(i, ctx) {
  const w = Math.abs(i.w),
    h = Math.abs(i.h),
    labelSize = i.fontSize || 18,
    family = fontFamily(i);
  const label = {
    font: `500 ${labelSize}px ${fontStack(family)}`,
    family,
    size: labelSize,
    bold: false,
    italic: false,
    color: "#30342f",
  };
  ctx.font = label.font;
  const lines = cachedWrapText(ctx, i.text || i.fileName || i.url || "", w - 32)
    .slice(0, 3)
    .map((text, n) => ({ text, x: 16, y: 16 + (n * labelSize * 4) / 3 }));
  let host = i.fileName || "";
  if (i.type === "link")
    try {
      host = new URL(i.url).hostname;
    } catch {
      host = "";
    }
  const small = (labelSize * 2) / 3;
  return {
    clip: { x: 12, y: 12, w: w - 24, h: h - 24 },
    label,
    lines,
    host: {
      text: host,
      x: 16,
      y: h - 30,
      style: {
        font: `400 ${small}px ${fontStack(family)}`,
        family,
        size: small,
        bold: false,
        italic: false,
        color: "#52624b",
      },
    },
  };
}

export function tableCells(i, ctx) {
  const layout = tableLayout(i),
    size = tableFontSize(i),
    align = tableTextAlign(i),
    style = {
      font: tableFont(i),
      family: fontFamily(i),
      size,
      bold: !!i.bold,
      italic: !!i.italic,
      color: "#30342f",
    };
  ctx.font = style.font;
  const cells = [];
  const lineHeight = size * 1.35;
  i.cells.forEach((row, r) =>
    row.forEach((value, c) => {
      const x = layout.x[c],
        y = layout.y[r],
        w = layout.columns[c],
        h = layout.rows[r],
        content = tableCellContent(i, r, c);
      let at = 0;
      cells.push({
        lang: content.lang,
        x,
        y,
        w,
        h,
        fill: r === 0 ? "#e6ebdf" : i.color || "#ffffff",
        clip: {
          x: x + 6,
          y: y + 6,
          w: Math.max(0, w - 12),
          h: Math.max(0, h - 12),
        },
        lines: cachedWrapText(ctx, value, w - 18)
          .slice(0, Math.max(0, Math.ceil((h - 9) / lineHeight)))
          .map((text, n) => {
            const start = value.indexOf(text, at);
            at = start + text.length;
            const parts = textSegments(
              text,
              sliceTextRuns(content.textRuns, start, start + text.length),
            );
            // Centred and right-aligned lines start where the board draws
            // them, measured in the table's font.
            const room =
              align === "left" ? 0 : w - 18 - ctx.measureText(text).width;
            return {
              text,
              parts,
              x: x + 9 + (align === "center" ? room / 2 : room),
              y: y + 9 + n * lineHeight,
            };
          }),
      });
    }),
  );
  return { style, cells };
}

// Image placement with its crop and optional oval mask, in local coordinates.
export function imageGeometry(i) {
  // A photo whose metadata, such as a colour profile, fills the start of
  // the file is measured from all of it.
  const size = imageSize(i.src) || imageSize(i.src, Infinity);
  if (!size?.width || !size?.height) return null;
  const { box, full } = imageLayout(i, size.width, size.height);
  const local = (r) => ({ x: r.x - i.x, y: r.y - i.y, w: r.w, h: r.h });
  const orientation = size.orientation || 1;
  return {
    width: size.width,
    height: size.height,
    box: local(box),
    full: local(full),
    mask: i.crop?.mask === "ellipse" ? "ellipse" : null,
    orientation,
    placement: storedPlacement(orientation, size, local(full)),
  };
}
// The matrix [a, b, c, d, e, f] (x = a u + c v + e, y = b u + d v + f) that
// draws a JPEG's stored pixels, `width` by `height` before its EXIF
// orientation turns them, as the shown image filling `full`.
function storedPlacement(orientation, shown, full) {
  const turned = orientation >= 5,
    w = turned ? shown.height : shown.width,
    h = turned ? shown.width : shown.height,
    sx = full.w / shown.width,
    sy = full.h / shown.height,
    x = full.x,
    y = full.y;
  const matrix = {
    1: [sx, 0, 0, sy, x, y],
    2: [-sx, 0, 0, sy, x + w * sx, y],
    3: [-sx, 0, 0, -sy, x + w * sx, y + h * sy],
    4: [sx, 0, 0, -sy, x, y + h * sy],
    5: [0, sy, sx, 0, x, y],
    6: [0, sy, -sx, 0, x + h * sx, y],
    7: [0, -sy, -sx, 0, x + h * sx, y + w * sy],
    8: [0, -sy, sx, 0, x, y + w * sy],
  }[orientation];
  return { width: w, height: h, matrix };
}

export function textOf(i) {
  if (i.type === "table")
    return i.cells.map((row) => row.join("\t")).join("\n");
  if (i.type === "file") return i.text || i.fileName || "";
  if (i.type === "link" || i.type === "embed") return i.text || i.url || "";
  return i.text || "";
}
