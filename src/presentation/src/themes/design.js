// A theme as a slide master design: the theme part, the master's background,
// artwork and text styles, and what each layout adds or changes, sized to the
// presentation's slides. The result is what `P.addDesignedSlideMaster` and
// `P.applySlideMasterDesign` take.
import {
  backgroundXml,
  colorXml,
  esc,
  fillXml,
  themeXml,
} from "./theme-xml.js";

const DARK_MAP = { bg1: "dk1", tx1: "lt1", bg2: "dk2", tx2: "lt2" };
const LIGHT_MAP = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

// ---------------------------------------------------------------------------
// Artwork. Positions and sizes are fractions of the slide.

let shapeCount = 0;
const spPrXml = (g, s, geometry) => {
  const x = Math.round(s.x * g.W),
    y = Math.round(s.y * g.H);
  const w = Math.max(1, Math.round(s.w * g.W)),
    h = Math.max(1, Math.round(s.h * g.H));
  const rot = s.rot ? ` rot="${Math.round(s.rot * 60000)}"` : "";
  const flip = `${s.flipH ? ' flipH="1"' : ""}${s.flipV ? ' flipV="1"' : ""}`;
  const ln = s.line
    ? `<a:ln w="${Math.round((s.line.width ?? 1) * 12700)}">${fillXml(s.line.color)}${s.line.dash ? `<a:prstDash val="${s.line.dash}"/>` : ""}</a:ln>`
    : "<a:ln><a:noFill/></a:ln>";
  return `<p:spPr><a:xfrm${rot}${flip}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${geometry(w, h)}${fillXml(s.fill ?? null)}${ln}</p:spPr>`;
};

/** One decorative shape as `<p:sp>`. */
export function shapeXml(g, s) {
  const id = ++shapeCount;
  const name = esc(s.name || `Decoration ${id}`);
  const geometry = s.path
    ? (w, h) => customGeometry(s.path, w, h)
    : () => {
        const adj = Object.entries(s.adj || {})
          .map(([k, v]) => `<a:gd name="${k}" fmla="val ${Math.round(v)}"/>`)
          .join("");
        return `<a:prstGeom prst="${s.preset || "rect"}"><a:avLst>${adj}</a:avLst></a:prstGeom>`;
      };
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>${spPrXml(g, s, geometry)}</p:sp>`;
}

/**
 * Custom geometry from a path over the unit square:
 * [["M", x, y], ["L", x, y], ["C", x1, y1, x2, y2, x, y], ["Z"]].
 */
function customGeometry(path, w, h) {
  const pt = (x, y) =>
    `<a:pt x="${Math.round(x * w)}" y="${Math.round(y * h)}"/>`;
  const body = path
    .map(([op, ...v]) =>
      op === "M"
        ? `<a:moveTo>${pt(v[0], v[1])}</a:moveTo>`
        : op === "L"
          ? `<a:lnTo>${pt(v[0], v[1])}</a:lnTo>`
          : op === "C"
            ? `<a:cubicBezTo>${pt(v[0], v[1])}${pt(v[2], v[3])}${pt(v[4], v[5])}</a:cubicBezTo>`
            : "<a:close/>",
    )
    .join("");
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}">${body}</a:path></a:pathLst></a:custGeom>`;
}

export const shapesXml = (g, list) =>
  (list || [])
    .filter(Boolean)
    .map((s) => shapeXml(g, s))
    .join("");

// Shape helpers for the catalog.
export const rect = (x, y, w, h, fill, more = {}) => ({
  x,
  y,
  w,
  h,
  fill,
  ...more,
});
export const ellipse = (x, y, w, h, fill, more = {}) => ({
  x,
  y,
  w,
  h,
  fill,
  preset: "ellipse",
  ...more,
});
/** A horizontal or vertical rule: a thin rectangle, `weight` points thick. */
export const hrule = (x, y, w, color, weight = 1.5) => ({
  x,
  y,
  w,
  h: weight / 540,
  fill: color,
});
export const vrule = (x, y, h, color, weight = 1.5) => ({
  x,
  y,
  w: weight / 960,
  h,
  fill: color,
});
export const poly = (points, fill, box = [0, 0, 1, 1], more = {}) => ({
  x: box[0],
  y: box[1],
  w: box[2],
  h: box[3],
  fill,
  path: [
    ["M", ...points[0]],
    ...points.slice(1).map((p) => ["L", ...p]),
    ["Z"],
  ],
  ...more,
});

// ---------------------------------------------------------------------------
// Text styles.

const levelsOf = (sizes) => sizes.length;

function titleStyleXml(t) {
  const caps = t.caps ? ' cap="all"' : "";
  const spc = t.spacing ? ` spc="${t.spacing}"` : "";
  const bold = t.bold ? ' b="1"' : "";
  return `<a:lvl1pPr algn="${t.align || "l"}" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="${t.lineSpacing || 90000}"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="${t.size || 4400}"${bold}${caps}${spc} kern="1200"><a:solidFill>${colorXml(t.color || "tx1")}</a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr>`;
}

function bodyStyleXml(b) {
  const sizes = b.sizes || [2400, 2000, 1800, 1600, 1600];
  const bullet = b.bullet ?? "•";
  const font = b.bulletFont || "Arial";
  return sizes
    .map((sz, i) => {
      const marL = 228600 + i * 457200;
      const bu =
        bullet === ""
          ? "<a:buNone/>"
          : `${b.bulletColor ? `<a:buClr>${colorXml(b.bulletColor)}</a:buClr>` : ""}<a:buFont typeface="${esc(font)}"/><a:buChar char="${esc(i % 2 ? b.subBullet || bullet : bullet)}"/>`;
      return `<a:lvl${i + 1}pPr marL="${marL}" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="${b.lineSpacing || 100000}"/></a:lnSpc><a:spcBef><a:spcPts val="${i === 0 ? 1000 : 500}"/></a:spcBef>${bu}<a:defRPr sz="${sz}" kern="1200"><a:solidFill>${colorXml(i === 0 ? b.color || "tx1" : b.subColor || b.color || "tx1")}</a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`;
    })
    .slice(0, levelsOf(sizes))
    .join("");
}

/** A lstStyle lvl1 override: alignment and size, and optionally color. */
export const levelStyle = (algn, size, color, more = "") =>
  `<a:lvl1pPr${algn ? ` algn="${algn}"` : ""}${more}><a:defRPr${size ? ` sz="${size}"` : ""}>${color ? `<a:solidFill>${colorXml(color)}</a:solidFill>` : ""}</a:defRPr></a:lvl1pPr>`;

/** Subtitle-like levels: no bullets, aligned, sized, colored. */
export const plainLevels = (algn, sizes, color) =>
  sizes
    .map(
      (sz, i) =>
        `<a:lvl${i + 1}pPr marL="0" indent="0"${algn ? ` algn="${algn}"` : ""}><a:buNone/><a:defRPr sz="${sz}">${color ? `<a:solidFill>${colorXml(color)}</a:solidFill>` : ""}</a:defRPr></a:lvl${i + 1}pPr>`,
    )
    .join("");

// ---------------------------------------------------------------------------
// The design.

/** The slide's size in EMU and a few standard positions, as fractions. */
export function geometry(size) {
  const W = Number(size?.width ?? size?.cx ?? 12192000);
  const H = Number(size?.height ?? size?.cy ?? 6858000);
  const px = (v) => Math.round(v * W),
    py = (v) => Math.round(v * H);
  const box = (x, y, w, h) => ({ x: px(x), y: py(y), w: px(w), h: py(h) });
  return { W, H, aspect: W / H, px, py, box };
}

/**
 * The master design for `theme` in `variant` at `size`. `override` replaces
 * the variant's colors, the theme's fonts or its effect scheme (the Colors,
 * Fonts and Effects menus).
 */
export function masterDesign(theme, variantIndex = 0, size, override = {}) {
  const variant = theme.variants[variantIndex] || theme.variants[0];
  const g = geometry(size);
  const colors = override.colors || { ...variant.colors, name: variant.name };
  const fonts = override.fonts || {
    name: theme.fontName || `${theme.fonts[0]}-${theme.fonts[1]}`,
    major: theme.fonts[0],
    minor: theme.fonts[1],
  };
  const dark = override.dark ?? !!variant.dark;
  const ctx = { g, variant, dark };
  const art = theme.art ? theme.art(ctx) : {};
  const layouts = {};
  for (const [type, design] of Object.entries(art.layouts || {})) {
    layouts[type] = {
      ...(design.background !== undefined
        ? {
            background:
              design.background === null
                ? null
                : backgroundXml(design.background),
          }
        : {}),
      ...(design.shapes ? { shapes: shapesXml(g, design.shapes) } : {}),
      ...(design.hideMaster !== undefined
        ? { hideMasterShapes: design.hideMaster }
        : {}),
      ...(design.colorMap !== undefined
        ? {
            colorMapOverride:
              design.colorMap === "dark"
                ? DARK_MAP
                : design.colorMap === "light"
                  ? LIGHT_MAP
                  : design.colorMap,
          }
        : {}),
      ...(design.placeholders ? { placeholders: design.placeholders } : {}),
    };
  }
  return {
    name: theme.name,
    themeXml: themeXml({
      name: theme.name,
      colors,
      fonts,
      effects: override.effects || theme.effects || "flat",
      backgrounds: theme.backgroundStyles || "calm",
    }),
    colorMap: dark ? DARK_MAP : LIGHT_MAP,
    background: backgroundXml(
      variant.background ?? art.background ?? theme.background ?? "bg1",
    ),
    shapes: shapesXml(g, art.master || []),
    titleStyle: titleStyleXml(theme.title || {}),
    bodyStyle: bodyStyleXml(theme.body || {}),
    placeholders: art.placeholders || [],
    layouts,
  };
}
