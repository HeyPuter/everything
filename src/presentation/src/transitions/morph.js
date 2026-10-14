// Morph: objects on the previous slide travel to where the same objects are
// on the next one, changing size, rotation and look on the way; objects only
// one slide has fade out or in, and the backgrounds cross-fade.
//
// Objects are paired by name first (a name starting with "!!" pairs only with
// the same name), then by kind and text, then by kind and picture or shape
// geometry, nearest first. Each object is drawn as its own picture (a layer),
// cropped to the area around it.
//
// With the Words or Characters option, text is taken apart: each word (or
// character) of one slide travels to the same word on the next slide,
// wherever it is, and the shapes behind the text morph as objects.

import { clamp, easeInOut, smooth } from "./effects-2d.js";

const DEFAULT_SIZE = { width: 12192000, height: 6858000 };

/** Facts used to pair one top-level shape with another. */
export function describeShape(P, pres, shape, size) {
  const bounds = P.getShapeBoundsResolved(pres, shape) || {
    x: 0,
    y: 0,
    w: size.width,
    h: size.height,
  };
  let image = null;
  try {
    image = P.getShapeImagePartName?.(shape) ?? null;
  } catch {
    image = null;
  }
  let preset = null;
  try {
    preset = P.getShapePreset?.(shape) ?? null;
  } catch {
    preset = null;
  }
  return {
    shape,
    id: P.getShapeId(shape),
    name: P.getShapeName(shape) || "",
    kind: P.getShapeKind(shape),
    text: (P.getShapeText(shape) || "").trim(),
    preset,
    image,
    // Fractions of the slide.
    box: {
      x: bounds.x / size.width,
      y: bounds.y / size.height,
      w: bounds.w / size.width,
      h: bounds.h / size.height,
    },
    rotation: ((P.getShapeRotation(shape) || 0) * Math.PI) / 180,
  };
}

/**
 * Pairs the shapes of two slides. Returns `{ pairs: [[a, b]], gone: [a],
 * added: [b] }` with `pairs` and `added` in the arriving slide's order.
 */
export function pairShapes(before, after) {
  const free = new Set(before);
  const match = new Map();
  const take = (b, test, rank = null) => {
    if (match.has(b)) return;
    let best = null,
      bestScore = Infinity;
    for (const a of free) {
      if (!test(a, b)) continue;
      const score = rank ? rank(a, b) : 0;
      if (score < bestScore) {
        best = a;
        bestScore = score;
      }
      if (!rank) break;
    }
    if (best) {
      free.delete(best);
      match.set(b, best);
    }
  };
  const forced = (s) => s.name.startsWith("!!");
  const distance = (a, b) =>
    Math.hypot(
      a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2),
      a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2),
    );
  for (const b of after) if (forced(b)) take(b, (a) => a.name === b.name);
  for (const b of after)
    if (!forced(b) && b.name)
      take(b, (a) => !forced(a) && a.name === b.name && a.kind === b.kind);
  for (const b of after)
    if (!forced(b) && b.text)
      take(
        b,
        (a) => !forced(a) && a.kind === b.kind && a.text === b.text,
        distance,
      );
  for (const b of after)
    if (!forced(b))
      take(
        b,
        (a) =>
          !forced(a) &&
          a.kind === b.kind &&
          (b.image
            ? a.image === b.image
            : b.preset
              ? a.preset === b.preset && !a.text === !b.text
              : false),
        distance,
      );
  const pairs = [],
    added = [];
  for (const b of after) {
    const a = match.get(b);
    if (a) pairs.push([a, b]);
    else added.push(b);
  }
  return { pairs, gone: before.filter((a) => free.has(a)), added };
}

/**
 * The words (or characters) of a line of text, as `{ text, start, end }`
 * ranges of string indexes. Spaces are not tokens.
 */
export function textTokens(line, mode) {
  const out = [];
  if (mode === "byChar") {
    let at = 0;
    for (const ch of line) {
      if (!/\s/.test(ch))
        out.push({ text: ch, start: at, end: at + ch.length });
      at += ch.length;
    }
    return out;
  }
  for (const m of line.matchAll(/\S+/g))
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * Matches tokens (`{ text, owner, box }`) of the leaving slide with those of
 * the arriving one: the same text, preferring the same pair of shapes, then
 * the nearest. Returns `{ pairs: [[a, b]], gone: [a], added: [b] }`.
 * `samePair(a, b)` says whether two tokens' shapes are paired.
 */
export function matchTokens(before, after, samePair = () => false) {
  const free = new Set(before);
  const pairs = [],
    added = [];
  const centre = (t) => [t.box.x + t.box.w / 2, t.box.y + t.box.h / 2];
  for (const b of after) {
    let best = null,
      bestScore = Infinity;
    const [bx, by] = centre(b);
    for (const a of free) {
      if (a.text !== b.text) continue;
      const [ax, ay] = centre(a);
      const score = Math.hypot(ax - bx, ay - by) + (samePair(a, b) ? 0 : 10);
      if (score < bestScore) {
        best = a;
        bestScore = score;
      }
    }
    if (best) {
      free.delete(best);
      pairs.push([best, b]);
    } else added.push(b);
  }
  return { pairs, gone: before.filter((a) => free.has(a)), added };
}

// Elements and attributes copied into the measuring SVG: text only, so no
// markup from the picture (images, links, styles) reaches the document.
const MEASURE_TAGS = new Set(["g", "text", "tspan"]);
const MEASURE_ATTRS = new Set([
  "x",
  "y",
  "dx",
  "dy",
  "transform",
  "text-anchor",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "baseline-shift",
  "dominant-baseline",
  "textLength",
  "lengthAdjust",
  "writing-mode",
]);
const SVG_NS = "http://www.w3.org/2000/svg";

function cleanCopy(node) {
  if (node.nodeType === 3) return document.createTextNode(node.data);
  if (node.nodeType !== 1 || !MEASURE_TAGS.has(node.localName)) return null;
  const copy = document.createElementNS(SVG_NS, node.localName);
  for (const a of node.attributes)
    if (MEASURE_ATTRS.has(a.name)) copy.setAttribute(a.name, a.value);
  const kerning = /font-kerning:\s*(\w+)/.exec(
    node.getAttribute("style") || "",
  );
  if (kerning) copy.style.fontKerning = kerning[1];
  const space = node.getAttribute("xml:space");
  if (space)
    copy.setAttributeNS(
      "http://www.w3.org/XML/1998/namespace",
      "xml:space",
      space,
    );
  for (const child of node.childNodes) {
    const c = cleanCopy(child);
    if (c) copy.append(c);
  }
  return copy;
}

/**
 * The boxes (fractions of the slide) of the words or characters a picture of
 * text draws, measured by laying its text out in the page. `svgText` is the
 * SVG of a text-only layer of one shape.
 */
export function measureTextTokens(svgText, mode) {
  if (typeof DOMParser === "undefined" || typeof document === "undefined")
    return [];
  const source = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = source.documentElement;
  if (!root || root.localName !== "svg") return [];
  const [, , vw, vh] = (root.getAttribute("viewBox") || "")
    .split(/[\s,]+/)
    .map(Number);
  if (!(vw > 0 && vh > 0)) return [];
  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("width", String(vw));
  host.setAttribute("height", String(vh));
  host.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    contain: "strict",
  });
  const lines = [];
  for (const text of source.querySelectorAll("text")) {
    if (text.closest("defs, clipPath, mask, pattern, symbol, marker")) continue;
    // Rebuild the chain of transforms down to the text.
    let parent = host;
    const chain = [];
    for (let n = text.parentElement; n && n !== root; n = n.parentElement)
      if (n.getAttribute("transform"))
        chain.unshift(n.getAttribute("transform"));
    for (const t of chain) {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", t);
      parent.append(g);
      parent = g;
    }
    const copy = cleanCopy(text);
    if (!copy) continue;
    parent.append(copy);
    lines.push(copy);
  }
  if (!lines.length) return [];
  document.body.append(host);
  const tokens = [];
  try {
    const hostMatrix = host.getScreenCTM()?.inverse();
    for (const line of lines) {
      const content = line.textContent || "";
      const count = line.getNumberOfChars?.() ?? 0;
      if (!count || count !== content.length) continue;
      const m = line.getScreenCTM();
      if (!m || !hostMatrix) continue;
      const toHost = hostMatrix.multiply(m);
      // Only upright text is taken apart; turned text morphs whole.
      if (Math.abs(toHost.b) > 1e-6 || Math.abs(toHost.c) > 1e-6) return [];
      for (const token of textTokens(content, mode)) {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let i = token.start; i < token.end; i++) {
          const r = line.getExtentOfChar(i);
          x0 = Math.min(x0, r.x);
          y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.width);
          y1 = Math.max(y1, r.y + r.height);
        }
        if (!(x1 > x0 && y1 > y0)) continue;
        const ax = toHost.a * x0 + toHost.e,
          bx = toHost.a * x1 + toHost.e;
        const ay = toHost.d * y0 + toHost.f,
          by = toHost.d * y1 + toHost.f;
        tokens.push({
          text: token.text,
          box: {
            x: Math.min(ax, bx) / vw,
            y: Math.min(ay, by) / vh,
            w: Math.abs(bx - ax) / vw,
            h: Math.abs(by - ay) / vh,
          },
          rotation: 0,
        });
      }
    }
  } finally {
    host.remove();
  }
  return tokens;
}

const svgOfUrl = (url) => {
  const comma = url.indexOf(",");
  if (!/^data:image\/svg\+xml/.test(url) || comma < 0) return null;
  const body = url.slice(comma + 1);
  return /;base64/.test(url.slice(0, comma))
    ? atob(body)
    : decodeURIComponent(body);
};

// The area a layer is cut from: the rotated box with room for outlines,
// shadows and text that runs over.
function cropArea(item, W, H) {
  const { box, rotation } = item;
  const w = box.w * W,
    h = box.h * H;
  const c = Math.abs(Math.cos(rotation)),
    s = Math.abs(Math.sin(rotation));
  const bw = w * c + h * s,
    bh = w * s + h * c;
  const cx = (box.x + box.w / 2) * W,
    cy = (box.y + box.h / 2) * H;
  const margin = Math.max(W, H) * 0.03 + Math.max(bw, bh) * 0.15;
  const x0 = Math.max(0, Math.floor(cx - bw / 2 - margin));
  const y0 = Math.max(0, Math.floor(cy - bh / 2 - margin));
  const x1 = Math.min(W, Math.ceil(cx + bw / 2 + margin));
  const y1 = Math.min(H, Math.ceil(cy + bh / 2 + margin));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * Prepares a morph between two slides: pairs their shapes and renders each
 * one, and both backgrounds, as pictures of width W and height H.
 * `render(slide, layer)` returns a picture URL for the given RenderSlideOptions
 * layer; `load(url)` resolves to a decoded image.
 */
export async function prepareMorph({
  P,
  pres,
  from,
  to,
  render,
  load,
  W,
  H,
  option = "byObject",
}) {
  const size = P.getSlideSize?.(pres) || DEFAULT_SIZE;
  const slideParts = (slide) => {
    const shapes = [];
    const bg = render(slide, {
      background: true,
      shape: (shape) => {
        shapes.push(shape);
        return false;
      },
    });
    return {
      bg,
      items: shapes
        .filter((shape) => {
          try {
            return !P.isShapeHidden?.(shape);
          } catch {
            return true;
          }
        })
        .map((shape) => describeShape(P, pres, shape, size)),
    };
  };
  const A = slideParts(from),
    B = slideParts(to);
  const { pairs, gone, added } = pairShapes(A.items, B.items);
  const raster = async (url, area = { x: 0, y: 0, w: W, h: H }) => {
    const image = await load(url);
    const canvas = document.createElement("canvas");
    canvas.width = area.w;
    canvas.height = area.h;
    canvas.getContext("2d").drawImage(image, -area.x, -area.y, W, H);
    return canvas;
  };
  const byText = option === "byWord" || option === "byChar";
  const tokens = { A: [], B: [] };
  const paragraphsOf = (shape) => {
    let count = 0;
    try {
      count = P.getShapeParagraphCount(shape);
    } catch {
      count = 0;
    }
    return new Set(Array.from({ length: count }, (_, i) => i));
  };
  // Words or characters of a shape's text, each cut from a picture of the
  // text alone. Resolves true when the text was taken apart.
  const splitText = async (slide, item, side) => {
    if (!byText || !item.text || item.rotation) return false;
    const paragraphs = paragraphsOf(item.shape);
    if (!paragraphs.size) return false;
    const url = render(slide, {
      background: false,
      shape: (shape) =>
        P.getShapeId(shape) === item.id ? { body: false, paragraphs } : false,
    });
    const svg = svgOfUrl(url);
    const found = svg ? measureTextTokens(svg, option) : [];
    if (!found.length) return false;
    const picture = await raster(url);
    for (const token of found) {
      const padY = token.box.h * 0.12;
      const padX = option === "byChar" ? 0.5 / W : token.box.h * 0.04;
      const crop = area(
        (token.box.x - padX) * W,
        (token.box.y - padY) * H,
        (token.box.x + token.box.w + padX) * W,
        (token.box.y + token.box.h + padY) * H,
        W,
        H,
      );
      const canvas = document.createElement("canvas");
      canvas.width = crop.w;
      canvas.height = crop.h;
      canvas
        .getContext("2d")
        .drawImage(
          picture,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          0,
          0,
          crop.w,
          crop.h,
        );
      tokens[side].push({
        ...token,
        owner: item,
        area: crop,
        picture: canvas,
      });
    }
    return true;
  };
  const layer = async (slide, item, side) => {
    const area = cropArea(item, W, H);
    const split = await splitText(slide, item, side);
    const url = render(slide, {
      background: false,
      shape: (shape) =>
        P.getShapeId(shape) === item.id
          ? split
            ? { body: true, paragraphs: new Set() }
            : true
          : false,
    });
    item.area = area;
    item.picture = await raster(url, area);
  };
  await Promise.all([
    raster(A.bg).then((c) => (A.bgPicture = c)),
    raster(B.bg).then((c) => (B.bgPicture = c)),
    ...A.items.map((item) => layer(from, item, "A")),
    ...B.items.map((item) => layer(to, item, "B")),
  ]);
  const paired = new Map(pairs.map(([a, b]) => [a, b]));
  // Tokens keep reading order (their shapes' order, then their own).
  const order = (list, items) =>
    list.sort((x, y) => items.indexOf(x.owner) - items.indexOf(y.owner));
  const words = byText
    ? matchTokens(
        order(tokens.A, A.items),
        order(tokens.B, B.items),
        (a, b) => paired.get(a.owner) === b.owner,
      )
    : null;
  return { A, B, pairs, gone, added, words };
}

const area = (x0, y0, x1, y1, W, H) => {
  const x = Math.max(0, Math.floor(x0)),
    y = Math.max(0, Math.floor(y0));
  return {
    x,
    y,
    w: Math.max(1, Math.min(W, Math.ceil(x1)) - x),
    h: Math.max(1, Math.min(H, Math.ceil(y1)) - y),
  };
};
const lerp = (a, b, t) => a + (b - a) * t;
// Shortest turn between two angles.
const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

// Sets the transform that carries `from`'s box onto the box `to` (both in
// fractions of the slide), so that a layer cut around `from` lands in place.
function carry(ctx, from, to, W, H) {
  const fw = from.box.w * W,
    fh = from.box.h * H;
  const tw = to.box.w * W,
    th = to.box.h * H;
  const sx = fw > 1 && tw > 0 ? tw / fw : 1;
  const sy = fh > 1 && th > 0 ? th / fh : 1;
  ctx.translate((to.box.x + to.box.w / 2) * W, (to.box.y + to.box.h / 2) * H);
  ctx.rotate(to.rotation);
  ctx.scale(sx, sy);
  ctx.rotate(-from.rotation);
  ctx.translate(
    -(from.box.x + from.box.w / 2) * W,
    -(from.box.y + from.box.h / 2) * H,
  );
}

function drawLayer(ctx, item, alpha, toward = item, W, H) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha);
  carry(ctx, item, toward, W, H);
  ctx.drawImage(item.picture, item.area.x, item.area.y);
  ctx.restore();
}

/** Draws the morph at progress q onto a 2D context of size W × H. */
export function drawMorph(ctx, scene, q, W, H, scratch) {
  const e = easeInOut(q);
  // Cross-dissolve by adding premultiplied colors: shapes that look alike
  // stay fully solid all the way through.
  const dissolve = (drawA, drawB, mix, r = { x: 0, y: 0, w: W, h: H }) => {
    const s = scratch.getContext("2d");
    s.globalCompositeOperation = "source-over";
    s.save();
    s.beginPath();
    s.rect(r.x, r.y, r.w, r.h);
    s.clip();
    s.clearRect(r.x, r.y, r.w, r.h);
    drawA(s, 1 - mix);
    s.globalCompositeOperation = "lighter";
    drawB(s, mix);
    s.restore();
    ctx.drawImage(scratch, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  };
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  dissolve(
    (s, a) => {
      s.globalAlpha = a;
      s.drawImage(scene.A.bgPicture, 0, 0, W, H);
      s.globalAlpha = 1;
    },
    (s, a) => {
      s.globalAlpha = a;
      s.drawImage(scene.B.bgPicture, 0, 0, W, H);
      s.globalAlpha = 1;
    },
    smooth(q),
  );
  const fadeOut = 1 - smooth(clamp(q * 1.6));
  const fadeIn = smooth(clamp(q * 1.6 - 0.6));
  for (const a of scene.gone) drawLayer(ctx, a, fadeOut, a, W, H);
  // Paired objects and new ones keep the arriving slide's stacking order.
  const order = new Map(scene.B.items.map((item, i) => [item, i]));
  const steps = [
    ...scene.pairs.map(([a, b]) => ({ at: order.get(b), a, b })),
    ...scene.added.map((b) => ({ at: order.get(b), b })),
  ].sort((x, y) => x.at - y.at);
  const mix = smooth(clamp((q - 0.15) / 0.7));
  for (const step of steps) {
    if (!step.a) {
      drawLayer(ctx, step.b, fadeIn, step.b, W, H);
      continue;
    }
    morphStep(ctx, step.a, step.b, e, mix, W, H, dissolve);
  }
  // Words and characters, over the shapes.
  if (scene.words) {
    for (const a of scene.words.gone) drawLayer(ctx, a, fadeOut, a, W, H);
    for (const b of scene.words.added) drawLayer(ctx, b, fadeIn, b, W, H);
    for (const [a, b] of scene.words.pairs)
      morphStep(ctx, a, b, e, mix, W, H, dissolve);
  }
}

// One object (or word) on its way from `a` to `b`.
function morphStep(ctx, a, b, e, mix, W, H, dissolve) {
  const now = {
    box: {
      x: lerp(a.box.x, b.box.x, e),
      y: lerp(a.box.y, b.box.y, e),
      w: lerp(a.box.w, b.box.w, e),
      h: lerp(a.box.h, b.box.h, e),
    },
    rotation: lerpAngle(a.rotation, b.rotation, e),
  };
  // Only the area the moving object covers is dissolved.
  const r = cropArea({ box: now.box, rotation: now.rotation }, W, H);
  const grow = Math.max(r.w, r.h) * 0.25;
  dissolve(
    (s, alpha) => drawLayer(s, a, alpha, now, W, H),
    (s, alpha) => drawLayer(s, b, alpha, now, W, H),
    mix,
    area(r.x - grow, r.y - grow, r.x + r.w + grow, r.y + r.h + grow, W, H),
  );
}
