// Standalone SVG previews of SmartArt layouts for galleries and dialogs,
// drawn from the same layout code as the saved drawing.
import { parsePresetGeometry } from "../../../internal/drawingml/preset-geometry.ts";
import { resolveGeometryArc } from "../../../internal/drawingml/geometry-arc.ts";
import { layoutEntry } from "./catalog.ts";
import { layoutSmartArt } from "./compute.ts";
import {
  type ArtShape,
  PT,
  adjustmentList,
  geometryTextRect,
  insetOf,
  paraPt,
} from "./kit.ts";
import {
  type ColorRef,
  DEFAULT_PALETTE,
  DEFAULT_SMARTART_COLORS,
  DEFAULT_SMARTART_STYLE,
  type SmartArtPalette,
  paintFor,
  resolveColor,
} from "./paint.ts";
import type { SmartArtItem } from "./model.ts";
import { xmlAttr, xmlText } from "./xml.ts";

const EMU_PER_PX = 9525;
// Gradient ids stay unique when several previews share one document.
let serial = 0;
const f = (v: number) => (Math.round(v * 100) / 100).toString();

/** SVG path data (in EMU, shape-local) for a laid-out shape. */
export const shapePathData = (
  s: ArtShape,
): { d: string; filled: boolean }[] => {
  if (s.geom === "custom") {
    return (s.path ?? []).map((line) => ({
      d:
        line.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("") +
        (s.closed ? "Z" : ""),
      filled: !!s.closed,
    }));
  }
  const geometry = parsePresetGeometry(s.geom, s.w, s.h, adjustmentList(s.adj));
  if (!geometry) return [{ d: `M0 0H${f(s.w)}V${f(s.h)}H0Z`, filled: true }];
  return geometry.paths.map((path) => {
    const sx = path.w ? s.w / path.w : 1,
      sy = path.h ? s.h / path.h : 1;
    let cx = 0,
      cy = 0;
    const parts: string[] = [];
    for (const c of path.commands) {
      switch (c.kind) {
        case "moveTo":
          cx = c.pt.x;
          cy = c.pt.y;
          parts.push(`M${f(cx * sx)} ${f(cy * sy)}`);
          break;
        case "lnTo":
          cx = c.pt.x;
          cy = c.pt.y;
          parts.push(`L${f(cx * sx)} ${f(cy * sy)}`);
          break;
        case "quadBezTo":
          parts.push(
            `Q${c.pts.map((p) => `${f(p.x * sx)} ${f(p.y * sy)}`).join(" ")}`,
          );
          cx = c.pts[1].x;
          cy = c.pts[1].y;
          break;
        case "cubicBezTo":
          parts.push(
            `C${c.pts.map((p) => `${f(p.x * sx)} ${f(p.y * sy)}`).join(" ")}`,
          );
          cx = c.pts[2].x;
          cy = c.pts[2].y;
          break;
        case "arcTo":
          for (const seg of resolveGeometryArc(
            cx,
            cy,
            c.wR,
            c.hR,
            c.stAng,
            c.swAng,
          )) {
            if (seg.kind === "line")
              parts.push(`L${f(seg.end.x * sx)} ${f(seg.end.y * sy)}`);
            else
              parts.push(
                `A${f(Math.abs(seg.rx * sx))} ${f(Math.abs(seg.ry * sy))} 0 0 ${seg.clockwise ? 1 : 0} ${f(seg.end.x * sx)} ${f(seg.end.y * sy)}`,
              );
            cx = seg.end.x;
            cy = seg.end.y;
          }
          break;
        case "close":
          parts.push("Z");
          break;
      }
    }
    return { d: parts.join(""), filled: path.fill !== "none" };
  });
};

export const smartArtPreviewSvg = (
  layoutId: string,
  opts: {
    width: number;
    height: number;
    colors?: string;
    style?: string;
    items?: ReadonlyArray<SmartArtItem>;
    palette?: SmartArtPalette;
    rightToLeft?: boolean;
  },
): string => {
  const entry = layoutEntry(layoutId);
  const width = Math.max(1, opts.width),
    height = Math.max(1, opts.height);
  const showText = !!opts.items;
  const model = {
    layout: entry?.id ?? "",
    items: opts.items ?? entry?.sample ?? [],
    colors: opts.colors ?? DEFAULT_SMARTART_COLORS,
    style: opts.style ?? DEFAULT_SMARTART_STYLE,
    ...(opts.rightToLeft ? { rightToLeft: true } : {}),
  };
  const palette = opts.palette ?? DEFAULT_PALETTE;
  // Lay out at the preview's size in EMU so fitting and insets match the slide.
  const pad = 0.04;
  const w = width * (1 - 2 * pad) * EMU_PER_PX,
    h = height * (1 - 2 * pad) * EMU_PER_PX;
  const shapes = entry ? layoutSmartArt(model, w, h) : [];
  const color = (c: ColorRef) => resolveColor(c, palette);
  const paint = (c: ColorRef | undefined, kind: "fill" | "stroke") => {
    if (!c) return ` ${kind}="none"`;
    const [hex, alpha] = color(c);
    return ` ${kind}="${hex}"${alpha < 1 ? ` ${kind}-opacity="${f(alpha)}"` : ""}`;
  };
  const out: string[] = [];
  let gradients = 0;
  const prefix = `smartart-${++serial}`;
  const defs: string[] = [];
  for (const s of shapes) {
    const p = paintFor(model.colors, model.style, s.role, s.index, s.count);
    const t = [
      `translate(${f(s.x / EMU_PER_PX)} ${f(s.y / EMU_PER_PX)})`,
      s.rot
        ? `rotate(${f(s.rot)} ${f(s.w / 2 / EMU_PER_PX)} ${f(s.h / 2 / EMU_PER_PX)})`
        : "",
      s.flipH || s.flipV
        ? `translate(${s.flipH ? f(s.w / EMU_PER_PX) : 0} ${s.flipV ? f(s.h / EMU_PER_PX) : 0}) scale(${s.flipH ? -1 : 1} ${s.flipV ? -1 : 1})`
        : "",
      `scale(${1 / EMU_PER_PX})`,
    ]
      .filter(Boolean)
      .join(" ");
    let fill = ` fill="none"`;
    if (p.fill?.kind === "solid") fill = paint(p.fill.color, "fill");
    else if (p.fill?.kind === "gradient") {
      const id = `${prefix}-g${gradients++}`;
      const [a, aa] = color(p.fill.from),
        [b, ba] = color(p.fill.to);
      defs.push(
        `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}" stop-opacity="${f(aa)}"/><stop offset="1" stop-color="${b}" stop-opacity="${f(ba)}"/></linearGradient>`,
      );
      fill = ` fill="url(#${id})"`;
    }
    const stroke = p.line
      ? `${paint(p.line.color, "stroke")} stroke-width="${f(Math.max(p.line.w, EMU_PER_PX * 0.75))}" stroke-linejoin="round"`
      : ` stroke="none"`;
    for (const path of shapePathData(s))
      out.push(
        `<path transform="${t}" d="${path.d}"${path.filled && s.geom !== "custom" ? fill : s.closed ? fill : ` fill="none"`}${stroke}/>`,
      );
    if (s.role === "pic") {
      // A small landscape glyph marks a picture placeholder.
      const g = Math.min(s.w, s.h) * 0.3;
      const gx = s.x + s.w / 2 - g / 2,
        gy = s.y + s.h / 2 - g / 2;
      const [hex] = color(p.text);
      out.push(
        `<path d="M${f(gx / EMU_PER_PX)} ${f((gy + g) / EMU_PER_PX)}l${f((g * 0.35) / EMU_PER_PX)} ${f((-g * 0.5) / EMU_PER_PX)}l${f((g * 0.25) / EMU_PER_PX)} ${f((g * 0.3) / EMU_PER_PX)}l${f((g * 0.15) / EMU_PER_PX)} ${f((-g * 0.15) / EMU_PER_PX)}l${f((g * 0.25) / EMU_PER_PX)} ${f((g * 0.35) / EMU_PER_PX)}z" fill="${hex}" fill-opacity="0.45"/>`,
      );
    }
    if (showText && s.paras?.length) {
      const rect = geometryTextRect(s);
      const inset = insetOf(s);
      const [hex, alpha] = color(p.text);
      const lines: {
        text: string;
        size: number;
        bullet: boolean;
        level: number;
      }[] = [];
      const pt = s.pt ?? 12;
      for (const para of s.paras)
        lines.push({
          text: para.text,
          size: paraPt(para, pt, s),
          bullet: para.bullet,
          level: para.level,
        });
      const total = lines.reduce((a, l) => a + l.size * PT * 1.1, 0);
      const box = {
        x: s.x + rect.x + inset,
        y: s.y + rect.y + inset,
        w: rect.w - 2 * inset,
        h: rect.h - 2 * inset,
      };
      let y =
        s.anchor === "t"
          ? box.y
          : s.anchor === "b"
            ? box.y + box.h - total
            : box.y + (box.h - total) / 2;
      for (const line of lines) {
        y += line.size * PT;
        const align = line.bullet ? "l" : (s.align ?? "ctr");
        const indent = line.bullet
          ? (line.level + 1) * line.size * PT * 0.9
          : 0;
        const x =
          align === "l"
            ? box.x + indent
            : align === "r"
              ? box.x + box.w
              : box.x + box.w / 2;
        out.push(
          `<text x="${f(x / EMU_PER_PX)}" y="${f(y / EMU_PER_PX)}" font-size="${f((line.size * PT) / EMU_PER_PX)}" font-family="sans-serif" fill="${hex}"${alpha < 1 ? ` fill-opacity="${f(alpha)}"` : ""} text-anchor="${align === "l" ? "start" : align === "r" ? "end" : "middle"}">${xmlText((line.bullet ? "• " : "") + line.text)}</text>`,
        );
        y += line.size * PT * 0.1;
      }
    }
  }
  const offset = `translate(${f(width * pad)} ${f(height * pad)})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(width)} ${f(height)}" width="${f(width)}" height="${f(height)}" role="img" aria-label="${xmlAttr(entry?.name ?? "SmartArt")}">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    `<g transform="${offset}">${out.join("")}</g></svg>`
  );
};
