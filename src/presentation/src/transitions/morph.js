// Morph: objects on the previous slide travel to where the same objects are
// on the next one, changing size, rotation and look on the way; objects only
// one slide has fade out or in, and the backgrounds cross-fade.
//
// Objects are paired by name first (a name starting with "!!" pairs only with
// the same name), then by kind and text, then by kind and picture or shape
// geometry, nearest first. Each object is drawn as its own picture (a layer),
// cropped to the area around it.

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
export async function prepareMorph({ P, pres, from, to, render, load, W, H }) {
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
  const layer = async (slide, item) => {
    const area = cropArea(item, W, H);
    const url = render(slide, {
      background: false,
      shape: (shape) => P.getShapeId(shape) === item.id,
    });
    item.area = area;
    item.picture = await raster(url, area);
  };
  await Promise.all([
    raster(A.bg).then((c) => (A.bgPicture = c)),
    raster(B.bg).then((c) => (B.bgPicture = c)),
    ...A.items.map((item) => layer(from, item)),
    ...B.items.map((item) => layer(to, item)),
  ]);
  return { A, B, pairs, gone, added };
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
    const { a, b } = step;
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
}
