// Lays out a parsed equation as boxes and draws it as SVG.
//
// Boxes follow the usual typesetting model: a width, a height above the
// baseline and a depth below it, all in ems of the equation's font size,
// and a `draw(x, y)` that returns SVG with the box's baseline at y. Text is
// set in a math font the system provides; rules, radicals and stretched
// brackets are drawn as paths so they fit whatever they enclose.

import { parseMath } from "./parse.js";

export const MATH_FONT =
  "'Cambria Math', 'STIX Two Math', 'Latin Modern Math', 'Cambria', 'Times New Roman', serif";
const AXIS = 0.25;
const RULE = 0.055;
const SCALE = { D: 1, T: 1, S: 0.7, SS: 0.5 };
const SMALLER = { D: "T", T: "S", S: "SS", SS: "SS" };
const SCRIPT = { D: "S", T: "S", S: "SS", SS: "SS" };

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const n = (v) => +v.toFixed(4);

// Rough glyph widths for when no font can be measured (tests, workers).
export function approximateMeasure(
  text,
  { italic = false, bold = false } = {},
) {
  let w = 0;
  for (const ch of text) {
    if (/[ilj.,;:'!|′]/.test(ch)) w += 0.28;
    else if (/[mwMW∑∏∫]/.test(ch)) w += 0.82;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else if (/[0-9]/.test(ch)) w += 0.5;
    else if (/[+−=<>±×÷≤≥≠≈≡→←⇒⇔∈∉⊂⊃⊆⊇∪∩]/.test(ch)) w += 0.72;
    else w += 0.5;
  }
  return w * (bold ? 1.06 : 1) * (italic ? 1.02 : 1);
}

let canvasMeasure = null;
// Measures with the browser's own fonts, the same ones the SVG draws with.
export function browserMeasure() {
  if (canvasMeasure) return canvasMeasure;
  if (typeof document === "undefined") return approximateMeasure;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return approximateMeasure;
  const cache = new Map();
  canvasMeasure = (
    text,
    { italic = false, bold = false, family = MATH_FONT } = {},
  ) => {
    const key = `${italic}${bold}${family}\u0000${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}100px ${family}`;
      w = ctx.measureText(text).width / 100;
      cache.set(key, w);
    }
    return w;
  };
  return canvasMeasure;
}

function glyphMetrics(text) {
  let h = 0.45,
    d = 0;
  for (const ch of text) {
    if (/[()[\]{}|‖⟨⟩⌊⌋⌈⌉/∫∮∬∭∑∏∐⋃⋂⋁⋀⨁⨂⨀]/.test(ch)) {
      h = Math.max(h, 0.75);
      d = Math.max(d, 0.25);
      continue;
    }
    if (/[+−=±×÷<>≤≥≠≈≡∼∝→←↔⇒⇐⇔⋅∗∘]/.test(ch)) {
      h = Math.max(h, 0.5);
      d = Math.max(d, 0.02);
      continue;
    }
    if (!/[acemnorsuvwxzαεικνοπστυω.,:;∙·−-]/.test(ch)) h = Math.max(h, 0.7);
    if (/[gjpqyβγζημξρφχψ,;]/.test(ch)) d = Math.max(d, 0.21);
  }
  return { h, d };
}

const DOUBLE_STRUCK = {
  C: "ℂ",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};
const SCRIPT_CAPS = {
  B: "ℬ",
  E: "ℰ",
  F: "ℱ",
  H: "ℋ",
  I: "ℐ",
  L: "ℒ",
  M: "ℳ",
  R: "ℛ",
};
function mapFont(text, font) {
  if (font === "bb")
    return [...text]
      .map(
        (c) =>
          DOUBLE_STRUCK[c] ??
          (/[A-Z]/.test(c)
            ? String.fromCodePoint(0x1d538 + c.charCodeAt(0) - 65)
            : /[a-z]/.test(c)
              ? String.fromCodePoint(0x1d552 + c.charCodeAt(0) - 97)
              : /[0-9]/.test(c)
                ? String.fromCodePoint(0x1d7d8 + c.charCodeAt(0) - 48)
                : c),
      )
      .join("");
  if (font === "cal")
    return [...text]
      .map(
        (c) =>
          SCRIPT_CAPS[c] ??
          (/[A-Z]/.test(c)
            ? String.fromCodePoint(0x1d49c + c.charCodeAt(0) - 65)
            : c),
      )
      .join("");
  return text;
}

export function layoutMath(
  source,
  { measure = approximateMeasure, color = "#000000" } = {},
) {
  const tree = typeof source === "string" ? parseMath(source) : source;

  const textBox = (
    text,
    style,
    {
      italic = false,
      bold = false,
      family = MATH_FONT,
      cls = "ord",
      scale = 1,
    } = {},
  ) => {
    const s = SCALE[style] * scale;
    const w = measure(text, { italic, bold, family }) * s;
    const { h, d } = glyphMetrics(text);
    return {
      w: w + (italic ? 0.04 * s : 0),
      h: h * s,
      d: d * s,
      cls,
      italic,
      draw: (x, y) =>
        text
          ? `<text x="${n(x)}" y="${n(y)}" font-size="${n(s)}"${italic ? ' font-style="italic"' : ""}${bold ? ' font-weight="bold"' : ""}${family !== MATH_FONT ? ` font-family="${esc(family)}"` : ""}>${esc(text)}</text>`
          : "",
    };
  };
  const empty = (cls = "ord") => ({ w: 0, h: 0, d: 0, cls, draw: () => "" });
  const shift = (box, dy) => ({
    ...box,
    h: box.h + dy,
    d: box.d - dy,
    draw: (x, y) => box.draw(x, y - dy),
  });
  const pad = (box, left, right = left) => ({
    ...box,
    w: box.w + left + right,
    draw: (x, y) => box.draw(x + left, y),
  });
  const hrule = (w, thickness, raise) => ({
    w,
    h: raise + thickness / 2,
    d: -(raise - thickness / 2),
    cls: "ord",
    draw: (x, y) =>
      `<rect x="${n(x)}" y="${n(y - raise - thickness / 2)}" width="${n(w)}" height="${n(thickness)}"/>`,
  });

  // Spacing between atom classes, in ems, as math typesetting spaces them.
  const SPACING = {
    "ord-op": 1,
    "ord-bin": 2,
    "ord-rel": 3,
    "ord-inner": 1,
    "op-ord": 1,
    "op-op": 1,
    "op-rel": 3,
    "op-inner": 1,
    "bin-ord": 2,
    "bin-op": 2,
    "bin-open": 2,
    "bin-inner": 2,
    "rel-ord": 3,
    "rel-op": 3,
    "rel-open": 3,
    "rel-inner": 3,
    "close-op": 1,
    "close-bin": 2,
    "close-rel": 3,
    "close-inner": 1,
    "punct-ord": 1,
    "punct-op": 1,
    "punct-rel": 1,
    "punct-open": 1,
    "punct-close": 1,
    "punct-punct": 1,
    "punct-inner": 1,
    "inner-ord": 1,
    "inner-op": 1,
    "inner-bin": 2,
    "inner-rel": 3,
    "inner-open": 1,
    "inner-punct": 1,
    "inner-inner": 1,
  };
  const SPACE_EM = { 1: 1 / 6, 2: 2 / 9, 3: 5 / 18 };

  function hlist(boxes, style) {
    const s = SCALE[style];
    // A binary operator with nothing to its left is a sign, not an operator.
    let previous = null;
    const classes = boxes.map((b) => {
      let cls = b.cls ?? "ord";
      if (
        cls === "bin" &&
        (!previous || ["bin", "op", "rel", "open", "punct"].includes(previous))
      )
        cls = "ord";
      if (b.space) return null;
      previous = cls;
      return cls;
    });
    for (let i = classes.length - 1; i >= 0; i--) {
      if (classes[i] !== "bin") continue;
      const next = classes.slice(i + 1).find((c) => c);
      if (!next || ["rel", "close", "punct"].includes(next)) classes[i] = "ord";
    }
    const placed = [];
    let x = 0,
      h = 0,
      d = 0,
      lastCls = null;
    boxes.forEach((b, i) => {
      const cls = classes[i];
      if (cls && lastCls) {
        const kind = SPACING[`${lastCls}-${cls}`];
        if (kind && (kind === 1 || style === "D" || style === "T"))
          x += SPACE_EM[kind] * s;
      }
      placed.push([b, x]);
      x += b.w;
      h = Math.max(h, b.h);
      d = Math.max(d, b.d);
      if (cls) lastCls = cls;
    });
    const first = classes.find((c) => c) ?? "ord";
    return {
      w: x,
      h,
      d,
      cls: boxes.length === 1 ? first : "ord",
      italic: boxes.length === 1 && boxes[0].italic,
      draw: (ox, oy) => placed.map(([b, bx]) => b.draw(ox + bx, oy)).join(""),
    };
  }

  function delimiter(ch, height, depth, style) {
    const s = SCALE[style];
    const total = height + depth;
    if (!ch) return { ...empty("open"), w: 0.12 * s };
    // Ordinary size: the font's own glyph.
    if (total <= 1.15 * s) {
      const box = textBox(ch, style);
      return { ...box, cls: "open" };
    }
    const t = 0.06 * s;
    const w = Math.min(0.85 * s, (0.32 + total * 0.06) * s);
    const top = -height,
      bottom = depth;
    const draw = (x, y) => {
      const y0 = y + top,
        y1 = y + bottom,
        ym = (y0 + y1) / 2;
      const l = x + 0.08 * s,
        r = x + w - 0.08 * s,
        c = (l + r) / 2;
      let d;
      switch (ch) {
        case "(":
          d = `M${n(r)} ${n(y0)}Q${n(l - 0.1 * s)} ${n(ym)} ${n(r)} ${n(y1)}`;
          break;
        case ")":
          d = `M${n(l)} ${n(y0)}Q${n(r + 0.1 * s)} ${n(ym)} ${n(l)} ${n(y1)}`;
          break;
        case "[":
          d = `M${n(r)} ${n(y0)}H${n(l)}V${n(y1)}H${n(r)}`;
          break;
        case "]":
          d = `M${n(l)} ${n(y0)}H${n(r)}V${n(y1)}H${n(l)}`;
          break;
        case "⌊":
          d = `M${n(l)} ${n(y0)}V${n(y1)}H${n(r)}`;
          break;
        case "⌋":
          d = `M${n(r)} ${n(y0)}V${n(y1)}H${n(l)}`;
          break;
        case "⌈":
          d = `M${n(r)} ${n(y0)}H${n(l)}V${n(y1)}`;
          break;
        case "⌉":
          d = `M${n(l)} ${n(y0)}H${n(r)}V${n(y1)}`;
          break;
        case "{": {
          const q = (y1 - y0) / 4;
          d = `M${n(r)} ${n(y0)}Q${n(c)} ${n(y0)} ${n(c)} ${n(y0 + q)}V${n(ym - q * 0.6)}Q${n(c)} ${n(ym)} ${n(l)} ${n(ym)}Q${n(c)} ${n(ym)} ${n(c)} ${n(ym + q * 0.6)}V${n(y1 - q)}Q${n(c)} ${n(y1)} ${n(r)} ${n(y1)}`;
          break;
        }
        case "}": {
          const q = (y1 - y0) / 4;
          d = `M${n(l)} ${n(y0)}Q${n(c)} ${n(y0)} ${n(c)} ${n(y0 + q)}V${n(ym - q * 0.6)}Q${n(c)} ${n(ym)} ${n(r)} ${n(ym)}Q${n(c)} ${n(ym)} ${n(c)} ${n(ym + q * 0.6)}V${n(y1 - q)}Q${n(c)} ${n(y1)} ${n(l)} ${n(y1)}`;
          break;
        }
        case "⟨":
          d = `M${n(r)} ${n(y0)}L${n(l)} ${n(ym)}L${n(r)} ${n(y1)}`;
          break;
        case "⟩":
          d = `M${n(l)} ${n(y0)}L${n(r)} ${n(ym)}L${n(l)} ${n(y1)}`;
          break;
        case "‖":
          d = `M${n(c - 0.06 * s)} ${n(y0)}V${n(y1)}M${n(c + 0.06 * s)} ${n(y0)}V${n(y1)}`;
          break;
        case "/":
          d = `M${n(r)} ${n(y0)}L${n(l)} ${n(y1)}`;
          break;
        default:
          d = `M${n(c)} ${n(y0)}V${n(y1)}`;
      }
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(t)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    };
    return { w, h: height, d: depth, cls: "open", draw };
  }

  function layout(node, style) {
    const s = SCALE[style];
    switch (node?.type) {
      case "row": {
        if (!node.items.length) return empty();
        return hlist(
          node.items.map((item) => layout(item, style)),
          style,
        );
      }
      case "char":
        return textBox(node.text, style, {
          italic: !!node.italic,
          cls: node.cls,
        });
      case "text":
        return node.font === "unknown"
          ? {
              ...textBox(node.text, style, { family: "monospace" }),
              cls: "ord",
            }
          : textBox(node.text, style, { family: MATH_FONT });
      case "font": {
        const map = (child) => {
          if (child.type === "char" || child.type === "text")
            return {
              ...child,
              type: "char",
              text: mapFont(child.text, node.font),
              italic: node.font === "it",
              bold: node.font === "bf",
              family: node.font === "sf" ? "sans-serif" : MATH_FONT,
            };
          if (child.type === "row")
            return { ...child, items: child.items.map(map) };
          return child;
        };
        const mapped = map(node.body);
        const draw = (child) =>
          child.type === "char"
            ? textBox(child.text, style, {
                italic: child.italic,
                bold: child.bold,
                family: child.family,
                cls: child.cls ?? "ord",
              })
            : child.type === "row"
              ? hlist(child.items.map(draw), style)
              : layout(child, style);
        return draw(mapped);
      }
      case "space":
        return {
          w: node.em * s,
          h: 0,
          d: 0,
          cls: null,
          space: true,
          draw: () => "",
        };
      case "placeholder": {
        const w = 0.55 * s,
          h = 0.68 * s;
        return {
          w: w + 0.06 * s,
          h,
          d: 0,
          cls: "ord",
          draw: (x, y) =>
            `<rect x="${n(x + 0.03 * s)}" y="${n(y - h)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="${n(0.035 * s)}" stroke-dasharray="${n(0.08 * s)} ${n(0.06 * s)}"/>`,
        };
      }
      case "func": {
        const box = textBox(node.text, style, { cls: "op" });
        return { ...box, limitsBelow: node.limits && style === "D" };
      }
      case "op": {
        const big =
          style === "D"
            ? node.integral
              ? 1.75
              : 1.45
            : node.integral
              ? 1.25
              : 1.05;
        const box = textBox(node.text, style, { scale: big, cls: "op" });
        // Centre the enlarged sign on the math axis.
        const center = (box.h - box.d) / 2;
        const lifted = shift(box, AXIS * s - center);
        return {
          ...lifted,
          w: lifted.w + (node.integral ? 0.1 * s : 0),
          cls: "op",
          limitsAbove: node.limits && style === "D",
          integral: node.integral,
        };
      }
      case "scripts":
        return scripts(node, style);
      case "frac":
        return fraction(node, style);
      case "sqrt":
        return radical(node, style);
      case "delim": {
        const body = layout(node.body, style);
        const extent =
          Math.max(body.h - AXIS * s, body.d + AXIS * s, 0.5 * s) + 0.08 * s;
        const left = delimiter(
          node.left,
          extent + AXIS * s,
          extent - AXIS * s,
          style,
        );
        const right = delimiter(
          node.right,
          extent + AXIS * s,
          extent - AXIS * s,
          style,
        );
        const box = hlist(
          [left, pad(body, 0.04 * s), { ...right, cls: "close" }],
          style,
        );
        return { ...box, cls: "inner" };
      }
      case "accent":
        return accent(node, style);
      case "stack": {
        const base = layout(node.base, style);
        const small = layout(node.over ?? node.under, SCRIPT[style]);
        const w = Math.max(base.w, small.w);
        const gap = 0.08 * s;
        const over = !!node.over;
        return {
          w,
          h: over ? base.h + gap + small.h + small.d : base.h,
          d: over ? base.d : base.d + gap + small.h + small.d,
          cls:
            base.cls === "rel" ||
            (node.base.items?.length === 1 && node.base.items[0].cls === "rel")
              ? "rel"
              : "ord",
          draw: (x, y) =>
            base.draw(x + (w - base.w) / 2, y) +
            small.draw(
              x + (w - small.w) / 2,
              over ? y - base.h - gap - small.d : y + base.d + gap + small.h,
            ),
        };
      }
      case "matrix":
        return matrix(node, style);
      default:
        return empty();
    }
  }

  function scripts(node, style) {
    const s = SCALE[style];
    const base = layout(node.base, style);
    const ss = SCRIPT[style];
    const sup = node.sup ? layout(node.sup, ss) : null;
    const sub = node.sub ? layout(node.sub, ss) : null;
    // Limits stacked over and under a large operator or limit-like function.
    if (base.limitsAbove || base.limitsBelow) {
      const gap = 0.12 * s;
      const w = Math.max(base.w, sup?.w ?? 0, sub?.w ?? 0);
      const h = base.h + (sup ? gap + sup.h + sup.d : 0);
      const d = base.d + (sub ? gap + sub.h + sub.d : 0);
      return {
        w,
        h,
        d,
        cls: "op",
        draw: (x, y) =>
          base.draw(x + (w - base.w) / 2, y) +
          (sup ? sup.draw(x + (w - sup.w) / 2, y - base.h - gap - sup.d) : "") +
          (sub ? sub.draw(x + (w - sub.w) / 2, y + base.d + gap + sub.h) : ""),
      };
    }
    let supShift = sup
      ? Math.max(0.42 * s, base.h - 0.28 * s, sup.d + 0.2 * s)
      : 0;
    let subShift = sub
      ? Math.max(0.18 * s, base.d + 0.08 * s, sub.h - 0.4 * s)
      : 0;
    if (base.integral) {
      supShift = Math.max(supShift, base.h - sup?.h * 0.6 || 0);
      subShift = Math.max(subShift, base.d - (sub?.d ?? 0));
    }
    if (sup && sub) {
      const gap = supShift - sup.d - (sub.h - subShift);
      if (gap < 0.12 * s) subShift += 0.12 * s - gap;
    }
    const kern = base.italic ? 0.04 * s : 0;
    const subKern = base.integral ? -0.18 * s : 0;
    const w =
      base.w +
      Math.max(sup ? sup.w + kern : 0, sub ? sub.w + subKern : 0) +
      0.03 * s;
    return {
      w,
      h: Math.max(base.h, sup ? supShift + sup.h : 0),
      d: Math.max(base.d, sub ? subShift + sub.d : 0),
      cls: base.cls,
      draw: (x, y) =>
        base.draw(x, y) +
        (sup ? sup.draw(x + base.w + kern, y - supShift) : "") +
        (sub ? sub.draw(x + base.w + subKern, y + subShift) : ""),
    };
  }

  function fraction(node, style) {
    const s = SCALE[style];
    const inner =
      node.style === "display"
        ? "T"
        : node.style === "text"
          ? SMALLER.T
          : SMALLER[style];
    const num = layout(node.num, inner);
    const den = layout(node.den, inner);
    const display = style === "D" || node.style === "display";
    const gap = (display ? 0.16 : 0.1) * s;
    const t = node.noBar ? 0 : RULE * s;
    const w = Math.max(num.w, den.w) + 0.2 * s;
    const axis = AXIS * s;
    const numShift = axis + t / 2 + gap + num.d;
    const denShift = t / 2 + gap + den.h - axis;
    return {
      w,
      h: numShift + num.h,
      d: denShift + den.d,
      cls: "inner",
      draw: (x, y) =>
        num.draw(x + (w - num.w) / 2, y - numShift) +
        den.draw(x + (w - den.w) / 2, y + denShift) +
        (t
          ? `<rect x="${n(x + 0.06 * s)}" y="${n(y - axis - t / 2)}" width="${n(w - 0.12 * s)}" height="${n(t)}"/>`
          : ""),
    };
  }

  function radical(node, style) {
    const s = SCALE[style];
    const body = layout(
      node.body,
      style.startsWith("S") ? style : style === "D" ? "T" : style,
    );
    const bodyBox = node.body.items?.length
      ? body
      : { ...body, w: 0.5 * s, h: 0.6 * s };
    const gap = 0.12 * s,
      t = RULE * s;
    const top = Math.max(bodyBox.h, 0.68 * s) + gap + t;
    const depth = Math.max(bodyBox.d, 0.05 * s) + 0.06 * s;
    const index = node.index?.items?.length ? layout(node.index, "SS") : null;
    const signW = 0.62 * s;
    const lead = index ? Math.max(0, index.w - 0.32 * s) : 0;
    const w = lead + signW + bodyBox.w + 0.1 * s;
    return {
      w,
      h: top + t / 2,
      d: depth,
      cls: "ord",
      draw: (x, y) => {
        const x0 = x + lead;
        const yTop = y - top;
        const path = `M${n(x0 + 0.04 * s)} ${n(y - 0.22 * s)}L${n(x0 + 0.16 * s)} ${n(y - 0.3 * s)}L${n(x0 + 0.34 * s)} ${n(y + depth)}L${n(x0 + signW - 0.04 * s)} ${n(yTop)}H${n(x0 + signW + bodyBox.w + 0.08 * s)}`;
        return (
          `<path d="${path}" fill="none" stroke="${color}" stroke-width="${n(t)}" stroke-linejoin="round" stroke-linecap="round"/>` +
          body.draw(x0 + signW + 0.02 * s, y) +
          (index
            ? index.draw(x0 + 0.3 * s - index.w + 0.02 * s, y - top * 0.55)
            : "")
        );
      },
    };
  }

  function accent(node, style) {
    const s = SCALE[style];
    const body = layout(node.body, style);
    const w = Math.max(body.w, 0.45 * s);
    const t = 0.05 * s;
    const stroke = (d) =>
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(t)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const lift = 0.1 * s;
    const mark = 0.2 * s;
    if (node.under) {
      const gap = 0.08 * s;
      const extra = node.name === "underbrace" ? 0.25 * s : t;
      return {
        w,
        h: body.h,
        d: body.d + gap + extra,
        cls: body.cls,
        draw: (x, y) => {
          const yy = y + body.d + gap;
          const l = x + 0.02 * s,
            r = x + w - 0.02 * s,
            c = (l + r) / 2;
          return (
            body.draw(x + (w - body.w) / 2, y) +
            (node.name === "underbrace"
              ? stroke(
                  `M${n(l)} ${n(yy)}Q${n(l)} ${n(yy + extra / 2)} ${n(l + 0.15 * s)} ${n(yy + extra / 2)}H${n(c - 0.12 * s)}Q${n(c)} ${n(yy + extra / 2)} ${n(c)} ${n(yy + extra)}Q${n(c)} ${n(yy + extra / 2)} ${n(c + 0.12 * s)} ${n(yy + extra / 2)}H${n(r - 0.15 * s)}Q${n(r)} ${n(yy + extra / 2)} ${n(r)} ${n(yy)}`,
                )
              : stroke(`M${n(l)} ${n(yy)}H${n(r)}`))
          );
        },
      };
    }
    const height = node.name === "overbrace" ? 0.28 * s : mark;
    return {
      w,
      h: body.h + lift + height,
      d: body.d,
      cls: body.cls,
      italic: body.italic,
      draw: (x, y) => {
        const yb = y - body.h - lift;
        const yt = yb - height;
        // Accents over an italic letter sit a little to its right.
        const skew = body.italic ? 0.06 * s : 0;
        const l = x + 0.04 * s + skew,
          r = x + w - 0.02 * s + skew,
          c = (l + r) / 2;
        const half = Math.min((r - l) / 2, node.wide ? w : 0.18 * s);
        let d;
        switch (node.name) {
          case "hat":
          case "widehat":
            d = `M${n(c - half)} ${n(yb)}L${n(c)} ${n(yt)}L${n(c + half)} ${n(yb)}`;
            break;
          case "check":
            d = `M${n(c - half)} ${n(yt)}L${n(c)} ${n(yb)}L${n(c + half)} ${n(yt)}`;
            break;
          case "tilde":
          case "widetilde":
            d = `M${n(c - half)} ${n(yb - mark * 0.2)}C${n(c - half / 2)} ${n(yt - mark * 0.2)} ${n(c + half / 2)} ${n(yb + mark * 0.2)} ${n(c + half)} ${n(yt + mark * 0.2)}`;
            break;
          case "bar":
          case "overline":
            d = `M${n(node.name === "bar" ? c - half : x + 0.02 * s)} ${n(yb - mark / 3)}H${n(node.name === "bar" ? c + half : x + w - 0.02 * s)}`;
            break;
          case "vec":
          case "overrightarrow":
            d = `M${n(node.name === "vec" ? c - half : l)} ${n(yb - mark / 2)}H${n(node.name === "vec" ? c + half : r)}M${n((node.name === "vec" ? c + half : r) - 0.1 * s)} ${n(yb - mark / 2 - 0.08 * s)}L${n(node.name === "vec" ? c + half : r)} ${n(yb - mark / 2)}L${n((node.name === "vec" ? c + half : r) - 0.1 * s)} ${n(yb - mark / 2 + 0.08 * s)}`;
            break;
          case "overleftarrow":
            d = `M${n(r)} ${n(yb - mark / 2)}H${n(l)}M${n(l + 0.1 * s)} ${n(yb - mark / 2 - 0.08 * s)}L${n(l)} ${n(yb - mark / 2)}L${n(l + 0.1 * s)} ${n(yb - mark / 2 + 0.08 * s)}`;
            break;
          case "overbrace": {
            const ym = yt,
              e = yb;
            const xl = x + 0.02 * s,
              xr = x + w - 0.02 * s,
              xc = (xl + xr) / 2;
            d = `M${n(xl)} ${n(e)}Q${n(xl)} ${n((e + ym) / 2)} ${n(xl + 0.15 * s)} ${n((e + ym) / 2)}H${n(xc - 0.12 * s)}Q${n(xc)} ${n((e + ym) / 2)} ${n(xc)} ${n(ym)}Q${n(xc)} ${n((e + ym) / 2)} ${n(xc + 0.12 * s)} ${n((e + ym) / 2)}H${n(xr - 0.15 * s)}Q${n(xr)} ${n((e + ym) / 2)} ${n(xr)} ${n(e)}`;
            break;
          }
          case "dot":
            return (
              body.draw(x + (w - body.w) / 2, y) +
              `<circle cx="${n(c)}" cy="${n(yb - mark / 3)}" r="${n(0.045 * s)}"/>`
            );
          case "ddot":
            return (
              body.draw(x + (w - body.w) / 2, y) +
              `<circle cx="${n(c - 0.09 * s)}" cy="${n(yb - mark / 3)}" r="${n(0.045 * s)}"/><circle cx="${n(c + 0.09 * s)}" cy="${n(yb - mark / 3)}" r="${n(0.045 * s)}"/>`
            );
          case "acute":
            d = `M${n(c - 0.05 * s)} ${n(yb)}L${n(c + 0.08 * s)} ${n(yt)}`;
            break;
          case "grave":
            d = `M${n(c + 0.05 * s)} ${n(yb)}L${n(c - 0.08 * s)} ${n(yt)}`;
            break;
          case "breve":
            d = `M${n(c - half)} ${n(yt)}Q${n(c)} ${n(yb + mark * 0.3)} ${n(c + half)} ${n(yt)}`;
            break;
          default:
            d = `M${n(l)} ${n(yb)}H${n(r)}`;
        }
        return body.draw(x + (w - body.w) / 2, y) + stroke(d);
      },
    };
  }

  function matrix(node, style) {
    const cellStyle = node.small ? "S" : style === "D" ? "T" : style;
    const s = SCALE[cellStyle];
    const boxes = node.rows.map((r) =>
      r.map((cell) => layout(cell, cellStyle)),
    );
    const cols = Math.max(0, ...boxes.map((r) => r.length));
    const colW = Array.from({ length: cols }, (_, c) =>
      Math.max(0, ...boxes.map((r) => r[c]?.w ?? 0)),
    );
    const rowH = boxes.map((r) => Math.max(0.7 * s, ...r.map((b) => b.h)));
    const rowD = boxes.map((r) => Math.max(0.25 * s, ...r.map((b) => b.d)));
    const rowGap = 0.25 * s;
    const aligned = node.align === "aligned";
    const colGap = (c) => (aligned ? (c % 2 ? 0.8 * s : 0) : 0.8 * s);
    let total = 0;
    rowH.forEach((h, i) => (total += h + rowD[i] + (i ? rowGap : 0)));
    const w =
      colW.reduce((a, b) => a + b, 0) +
      colW.slice(1).reduce((sum, _, i) => sum + colGap(i + 1), 0);
    const axis = AXIS * SCALE[style];
    const top = total / 2 + axis;
    return {
      w: w + 0.1 * s,
      h: top,
      d: total - top,
      cls: "inner",
      draw: (x, y) => {
        let out = "";
        let yy = y - top;
        boxes.forEach((r, i) => {
          yy += (i ? rowGap : 0) + rowH[i];
          let xx = x + 0.05 * s;
          for (let c = 0; c < cols; c++) {
            if (c) xx += colGap(c);
            const b = r[c];
            if (b) {
              const offset = aligned
                ? c % 2 === 0 && cols > 1
                  ? colW[c] - b.w
                  : 0
                : (colW[c] - b.w) / 2;
              out += b.draw(xx + offset, yy);
            }
            xx += colW[c];
          }
          yy += rowD[i];
        });
        return out;
      },
    };
  }

  return layout(tree, "D");
}

/**
 * Renders an equation to an SVG document. `size` is the font size in
 * pixels; the result's width and height are in the same pixels.
 */
export function renderMathSvg(
  source,
  {
    size = 48,
    color = "#000000",
    measure = approximateMeasure,
    padding = 0.12,
  } = {},
) {
  const box = layoutMath(source, { measure, color });
  const w = Math.max(box.w, 0.3) + padding * 2;
  const h = Math.max(box.h, 0.5) + Math.max(box.d, 0.1) + padding * 2;
  const baseline = padding + Math.max(box.h, 0.5);
  const body = box.draw(padding, baseline);
  const width = Math.ceil(w * size);
  const height = Math.ceil(h * size);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${n(w)} ${n(h)}"><g fill="${esc(color)}" font-family="${esc(MATH_FONT)}">${body}</g></svg>`;
  return { svg, width, height, baseline: baseline * size };
}
