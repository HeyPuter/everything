// Plays a slide's animations over a frame: the slide show's, or the editing
// canvas's for a preview.
//
// The slide is drawn as a stack of pictures in its own z-order: runs of
// shapes that never move share one picture, and every animated shape (or, for
// a text build, each of its paragraphs and its background) gets a picture of
// its own that the Web Animations API moves, fades, clips and recolors.
//
// Effects come from P.getSlideAnimations: a flat list in the main sequence's
// order (then each trigger's). Playing follows the file's model: a click
// starts a click group; "with previous" effects start together; "after
// previous" effects start when the time group before them ends.

import { P, groupParents, slideBounds, slideRotation } from "../model.js";
import { entryFor } from "./catalog.js";
import { playEffectSound, stopEffectSounds } from "../transitions/sounds.js";

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Timeline: effects → click groups of timed items.

/** The effects' paragraph targets: each item plays on these paragraph
 *  indexes of its shape (null = the whole shape, "bg" = its background). */
function expandItems(slide, effects) {
  const items = [];
  effects.forEach((effect, index) => {
    const base = { effect, index, shapeId: effect.shapeId };
    if (effect.text) {
      let groups = P.getShapeBuildParagraphs(
        slide,
        effect.shapeId,
        effect.text.level,
      );
      if (effect.text.reverse) groups = groups.reverse();
      const parts = [];
      if (effect.text.animateBackground)
        parts.push({ part: "bg", start: effect.start, delay: effect.delayMs });
      for (const g of groups) {
        const first = parts.length === 0;
        parts.push({
          part: rangeOf(g),
          start: first
            ? effect.start
            : effect.text.by === "allAtOnce"
              ? "with"
              : effect.text.autoAfterMs !== undefined ||
                  effect.start !== "click"
                ? "after"
                : "click",
          delay:
            first || effect.text.by === "allAtOnce"
              ? effect.delayMs
              : (effect.text.autoAfterMs ?? effect.delayMs),
        });
      }
      if (parts.length) {
        parts.forEach((p, sub) =>
          items.push({
            ...base,
            sub,
            part: p.part,
            start: p.start,
            delay: p.delay,
          }),
        );
        return;
      }
    }
    items.push({
      ...base,
      sub: 0,
      part: effect.paragraphs
        ? rangeOf(effect.paragraphs)
        : effect.background
          ? "bg"
          : null,
      start: effect.start,
      delay: effect.delayMs,
    });
  });
  return items;
}
const rangeOf = (g) => {
  const out = [];
  for (let i = g.start; i <= g.end; i++) out.push(i);
  return out;
};

export const totalDuration = (effect) =>
  effect.durationMs *
  (typeof effect.repeat === "number" ? effect.repeat : 1) *
  (effect.autoReverse ? 2 : 1);

/** Click groups of items, each item with its start time in the group. */
export function buildSequence(items, { main = true } = {}) {
  const groups = [];
  let group = null;
  let subOffset = 0;
  let subEnd = 0;
  for (const item of items) {
    let start = item.start;
    if (!group) {
      group = { auto: main && start !== "click", items: [] };
      groups.push(group);
      subOffset = subEnd = 0;
      if (!main) start = "click";
    } else if (start === "click") {
      group = { auto: false, items: [] };
      groups.push(group);
      subOffset = subEnd = 0;
    } else if (start === "after") subOffset = subEnd;
    const at = subOffset + item.delay;
    group.items.push({ ...item, at });
    subEnd = Math.max(subEnd, at + totalDuration(item.effect));
  }
  return groups;
}

/** Click steps of a slide's main sequence, for counting and badges. */
export function slideTimeline(slide, effects = P.getSlideAnimations(slide)) {
  const main = effects.filter((e) => e.trigger === undefined);
  const groups = buildSequence(expandItems(slide, main));
  return { effects, groups };
}

// ---------------------------------------------------------------------------
// Pieces: what is drawn separately.

function topLevelShapes(slide) {
  const parents = groupParents(slide);
  return P.getSlideShapes(slide).filter(
    (s) => !parents.has(P.getShapeId(s)) && !P.isShapeHidden(s),
  );
}

function piecesOf(pres, slide, items) {
  const parents = groupParents(slide);
  const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
  const animated = new Map(); // shape id → Set of parts ("whole" | "bg" | n)
  for (const item of items) {
    const parts = animated.get(item.shapeId) ?? new Set();
    if (item.part === null) parts.add("whole");
    else if (item.part === "bg") parts.add("bg");
    else item.part.forEach((n) => parts.add(n));
    animated.set(item.shapeId, parts);
  }
  const runs = []; // static runs and animated pieces, bottom to top
  let run = null;
  const addStatic = (shapeId, part) => {
    if (!run) runs.push((run = { kind: "static", shapes: new Map() }));
    run.shapes.set(shapeId, part);
  };
  for (const shape of topLevelShapes(slide)) {
    const id = String(P.getShapeId(shape));
    const parts = animated.get(id);
    if (!parts) {
      addStatic(id, true);
      continue;
    }
    const b = slideBounds(pres, shape, parents) || { x: 0, y: 0, w: 0, h: 0 };
    const box = {
      x: b.x / size.width,
      y: b.y / size.height,
      w: b.w / size.width,
      h: b.h / size.height,
      rotation: slideRotation(shape, parents),
    };
    let lines = [];
    try {
      lines = P.getShapeText(shape).split("\n");
    } catch {}
    const paragraphs = [...parts].filter((p) => typeof p === "number");
    if (!paragraphs.length) {
      run = null;
      runs.push({
        kind: "piece",
        shapeId: id,
        part: "whole",
        box,
        layer: true,
        text: lines.join(" "),
      });
      continue;
    }
    let count = 0;
    try {
      count = P.getShapeParagraphCount(shape);
    } catch {}
    // The background: animated when an item targets it or the whole shape,
    // otherwise it stays put with the shapes around it.
    if (parts.has("bg") || parts.has("whole")) {
      run = null;
      runs.push({
        kind: "piece",
        shapeId: id,
        part: "bg",
        box,
        layer: { body: true, paragraphs: new Set() },
      });
    } else addStatic(id, { body: true, paragraphs: new Set() });
    for (let n = 0; n < count; n++) {
      if (parts.has(n) || parts.has("whole")) {
        run = null;
        runs.push({
          kind: "piece",
          shapeId: id,
          part: n,
          box,
          layer: { body: false, paragraphs: new Set([n]) },
          text: lines[n] || "",
        });
      } else addStatic(id, { body: false, paragraphs: new Set([n]) });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Keyframes for each effect.

const pct = (n) => `${+(n * 100).toFixed(3)}%`;
const insetBox = (b) =>
  `inset(${pct(b.y)} ${pct(1 - b.x - b.w)} ${pct(1 - b.y - b.h)} ${pct(b.x)})`;
const polygon = (pts, evenodd = false) =>
  `polygon(${evenodd ? "evenodd, " : ""}${pts.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(", ")})`;
const rectPts = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
// Deterministic "random" order for bar and dissolve effects.
const shuffled = (n, seed) => {
  const order = [...Array(n).keys()];
  let s = seed || 1;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

function bandsFrames(b, { vertical = false, count = 24, random = true, seed }) {
  const order = random ? shuffled(count, seed) : [...Array(count).keys()];
  const reveal = new Array(count);
  order.forEach((band, rank) => (reveal[band] = rank / count));
  const steps = 12;
  const frames = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const grow = random
        ? Math.min(1, Math.max(0, (t - reveal[i]) * count))
        : t;
      if (vertical) {
        const x0 = b.x + (b.w * i) / count;
        const x1 = x0 + (b.w / count) * grow;
        pts.push([x0, b.y], [x1, b.y], [x1, b.y + b.h], [x0, b.y + b.h]);
        pts.push([x0, b.y]);
      } else {
        const y0 = b.y + (b.h * i) / count;
        const y1 = y0 + (b.h / count) * grow;
        pts.push([b.x, y0], [b.x + b.w, y0], [b.x + b.w, y1], [b.x, y1]);
      }
    }
    frames.push({ clipPath: polygon(pts) });
  }
  return frames;
}

function wheelFrames(b, spokes, frame) {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  // Radius in each axis's units, large enough to cover the box.
  const r = Math.hypot(b.w * frame.w, b.h * frame.h) / 2 + 2;
  const rx = r / frame.w,
    ry = r / frame.h;
  const per = 10;
  const frames = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const pts = [];
    for (let s = 0; s < spokes; s++) {
      const a0 = -Math.PI / 2 + (2 * Math.PI * s) / spokes;
      const sweep = ((2 * Math.PI) / spokes) * t;
      pts.push([cx, cy]);
      for (let i = 0; i <= per; i++) {
        const a = a0 + (sweep * i) / per;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
    }
    frames.push({ clipPath: polygon(pts) });
  }
  return frames;
}

function shapeFrames(b, kind, out, frame) {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const outline = (t) => {
    // The shape's outline at scale t (0..1) about the box center, as many
    // points as every kind shares so frames interpolate.
    const n = 32;
    const pts = [];
    const r = Math.hypot(b.w * frame.w, b.h * frame.h) / 2 + 2;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      let x = Math.cos(a),
        y = Math.sin(a);
      if (kind === "box") {
        const m = Math.max(Math.abs(x), Math.abs(y));
        x /= m;
        y /= m;
        x *= b.w / 2;
        y *= b.h / 2;
        x *= frame.w;
        y *= frame.h;
      } else if (kind === "diamond") {
        const m = Math.abs(x) + Math.abs(y);
        x = (x / m) * b.w * frame.w;
        y = (y / m) * b.h * frame.h;
      } else if (kind === "plus") {
        const m = Math.max(Math.abs(x), Math.abs(y));
        const arm = Math.min(Math.abs(x), Math.abs(y)) / m < 0.42 ? 1 : 0.42;
        x = (x / m) * arm * b.w * frame.w;
        y = (y / m) * arm * b.h * frame.h;
      } else {
        x *= r;
        y *= r;
      }
      pts.push([cx + (x * t) / frame.w, cy + (y * t) / frame.h]);
    }
    return pts;
  };
  const frames = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    if (out) frames.push({ clipPath: polygon(outline(t)) });
    else {
      // Closing in from the box's edge to its center: the box less a
      // shrinking hole.
      const big = 1.5;
      frames.push({
        clipPath: polygon(
          [
            ...rectPts(b.x - b.w, b.y - b.h, b.x + 2 * b.w, b.y + 2 * b.h),
            [b.x - b.w, b.y - b.h],
            ...outline(big * (1 - t)),
            outline(big * (1 - t))[0],
          ],
          true,
        ),
      });
    }
  }
  return frames;
}

function dirOf(subtype) {
  return {
    top: !!(subtype & 1),
    right: !!(subtype & 2),
    bottom: !!(subtype & 4),
    left: !!(subtype & 8),
  };
}

/** Entrance keyframes (exits play them backward) on the piece's fx layer. */
function entranceFrames(effect, b, frame) {
  const id = effect.presetId;
  const sub = effect.presetSubtype;
  const show = (frames) => frames.map((f) => ({ visibility: "visible", ...f }));
  switch (id) {
    case 1:
      return show([
        { opacity: 0 },
        { opacity: 0, offset: 0.999 },
        { opacity: 1 },
      ]);
    case 2:
    case 12: {
      const d = dirOf(sub || 4);
      const far = id === 2;
      const tx = d.left
        ? far
          ? -(b.x + b.w)
          : -b.w * 0.5
        : d.right
          ? far
            ? 1 - b.x
            : b.w * 0.5
          : 0;
      const ty = d.top
        ? far
          ? -(b.y + b.h)
          : -b.h * 0.5
        : d.bottom
          ? far
            ? 1 - b.y
            : b.h * 0.5
          : 0;
      return show([
        {
          transform: `translate(${pct(tx)}, ${pct(ty)})`,
          ...(far ? {} : { opacity: 0 }),
        },
        { transform: "translate(0, 0)", ...(far ? {} : { opacity: 1 }) },
      ]);
    }
    case 42:
    case 47:
    case 37: {
      const dy = id === 37 ? 1 - b.y : id === 42 ? 0.1 : -0.1;
      return show([
        { opacity: 0, transform: `translate(0, ${pct(dy)})` },
        { opacity: 1, transform: "translate(0, 0)" },
      ]);
    }
    case 16: {
      const vertical = sub === 21 || sub === 37;
      const out = sub === 37 || sub === 42;
      const x0 = b.x,
        x1 = b.x + b.w,
        y0 = b.y,
        y1 = b.y + b.h,
        cx = b.x + b.w / 2,
        cy = b.y + b.h / 2;
      if (out)
        return show([
          {
            clipPath: polygon(
              vertical ? rectPts(cx, y0, cx, y1) : rectPts(x0, cy, x1, cy),
            ),
          },
          { clipPath: polygon(rectPts(x0, y0, x1, y1)) },
        ]);
      const hole = (t) =>
        vertical
          ? rectPts(x0 + (cx - x0) * t, y0 - 1, x1 - (x1 - cx) * t, y1 + 1)
          : rectPts(x0 - 1, y0 + (cy - y0) * t, x1 + 1, y1 - (y1 - cy) * t);
      const outer = rectPts(x0, y0, x1, y1);
      return show([
        { clipPath: polygon([...outer, ...hole(0)], true) },
        { clipPath: polygon([...outer, ...hole(1)], true) },
      ]);
    }
    case 22:
    case 18: {
      const d = dirOf(id === 18 ? (sub & 4 ? 4 : 1) : sub || 4);
      const from = d.bottom
        ? `inset(${pct(b.y + b.h)} 0 0 0)`
        : d.top
          ? `inset(0 0 ${pct(1 - b.y)} 0)`
          : d.left
            ? `inset(0 ${pct(1 - b.x)} 0 0)`
            : `inset(0 0 0 ${pct(b.x + b.w)})`;
      const to = d.bottom
        ? `inset(${pct(b.y)} 0 0 0)`
        : d.top
          ? `inset(0 0 ${pct(1 - b.y - b.h)} 0)`
          : d.left
            ? `inset(0 ${pct(1 - b.x - b.w)} 0 0)`
            : `inset(0 0 0 ${pct(b.x)})`;
      return show([{ clipPath: from }, { clipPath: to }]);
    }
    case 4:
    case 6:
    case 8:
    case 13:
      return show(
        shapeFrames(
          b,
          { 4: "box", 6: "circle", 8: "diamond", 13: "plus" }[id],
          sub !== 16,
          frame,
        ),
      );
    case 21:
      return show(
        wheelFrames(b, [1, 2, 3, 4, 8].includes(sub) ? sub : 1, frame),
      );
    case 20:
      return show(wheelFrames(b, 2, frame));
    case 14:
      return show(bandsFrames(b, { vertical: sub === 5, seed: 7 }));
    case 3:
      return show(
        bandsFrames(b, { vertical: sub === 5, count: 8, random: false }),
      );
    case 5:
      return show(bandsFrames(b, { vertical: sub !== 5, count: 16, seed: 3 }));
    case 9:
      return show(bandsFrames(b, { count: 48, seed: 11 }));
    case 31:
      return show([
        { opacity: 0, transform: "rotate(-90deg) scale(0)" },
        { opacity: 1, transform: "rotate(0deg) scale(1)" },
      ]);
    case 53:
      return show([
        { opacity: 0, transform: "scale(0)" },
        { opacity: 1, transform: "scale(1)" },
      ]);
    case 23:
      return show([{ transform: "scale(0)" }, { transform: "scale(1)" }]);
    case 17:
      return show([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }]);
    case 55:
      return show([
        { opacity: 0, transform: "scaleX(0.7)" },
        { opacity: 1, transform: "scaleX(1)" },
      ]);
    case 43:
    case 49:
      return show([
        {
          opacity: 0,
          transform: `rotate(${id === 49 ? -360 : -180}deg) scale(0)`,
        },
        { opacity: 1, transform: "rotate(0deg) scale(1)" },
      ]);
    case 19:
      return show([
        { transform: "perspective(1200px) rotateY(90deg)", opacity: 0 },
        {
          transform: "perspective(1200px) rotateY(-60deg)",
          opacity: 1,
          offset: 0.35,
        },
        { transform: "perspective(1200px) rotateY(40deg)", offset: 0.6 },
        { transform: "perspective(1200px) rotateY(-18deg)", offset: 0.8 },
        { transform: "perspective(1200px) rotateY(0deg)" },
      ]);
    case 26: {
      const lift = -(b.y + b.h) * 0.6;
      return show([
        { transform: `translate(-6%, ${pct(lift)})`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: "translate(0, 0)", offset: 0.45 },
        { transform: `translate(0, ${pct(lift * 0.25)})`, offset: 0.62 },
        { transform: "translate(0, 0)", offset: 0.78 },
        { transform: `translate(0, ${pct(lift * 0.06)})`, offset: 0.89 },
        { transform: "translate(0, 0)" },
      ]);
    }
    default:
      return show([{ opacity: 0 }, { opacity: 1 }]);
  }
}

// Motion paths: "M x y L x y C x1 y1 x2 y2 x y Z E", slide-relative.
export function parsePath(d) {
  const tokens = String(d || "").match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/gi) || [];
  const segs = [];
  let i = 0;
  let cmd = null;
  let cur = [0, 0],
    start = [0, 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === "E") break;
    if (cmd === "M") {
      cur = start = [num(), num()];
      cmd = "L";
      if (!segs.length) continue;
      segs.push({ kind: "M", to: cur });
    } else if (cmd === "L") {
      const to = [num(), num()];
      segs.push({ kind: "L", from: cur, to });
      cur = to;
    } else if (cmd === "C") {
      const c1 = [num(), num()],
        c2 = [num(), num()],
        to = [num(), num()];
      segs.push({ kind: "C", from: cur, c1, c2, to });
      cur = to;
    } else if (cmd === "Z") {
      segs.push({ kind: "L", from: cur, to: start });
      cur = start;
      cmd = null;
    } else i++;
  }
  return segs;
}
export function samplePath(d, count = 48) {
  const segs = parsePath(d).filter((s) => s.kind !== "M");
  if (!segs.length) return [[0, 0]];
  const at = (s, t) => {
    if (s.kind === "L")
      return [
        s.from[0] + (s.to[0] - s.from[0]) * t,
        s.from[1] + (s.to[1] - s.from[1]) * t,
      ];
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        u * u * u * s.from[k] +
        3 * u * u * t * s.c1[k] +
        3 * u * t * t * s.c2[k] +
        t * t * t * s.to[k],
    );
  };
  // Even spacing along the path's length.
  const fine = [];
  for (const s of segs) for (let k = 0; k < 24; k++) fine.push(at(s, k / 24));
  fine.push(segs[segs.length - 1].to);
  const lengths = [0];
  for (let k = 1; k < fine.length; k++)
    lengths.push(
      lengths[k - 1] +
        Math.hypot(fine[k][0] - fine[k - 1][0], fine[k][1] - fine[k - 1][1]),
    );
  const total = lengths[lengths.length - 1] || 1;
  const out = [];
  let j = 0;
  for (let n = 0; n <= count; n++) {
    const want = (total * n) / count;
    while (j < lengths.length - 2 && lengths[j + 1] < want) j++;
    const span = lengths[j + 1] - lengths[j] || 1;
    const t = Math.min(1, Math.max(0, (want - lengths[j]) / span));
    out.push([
      fine[j][0] + (fine[j + 1][0] - fine[j][0]) * t,
      fine[j][1] + (fine[j + 1][1] - fine[j][1]) * t,
    ]);
  }
  return out;
}
export function pathEnd(d) {
  const segs = parsePath(d);
  return segs.length ? segs[segs.length - 1].to : [0, 0];
}

const emphTransform = (s) =>
  `rotate(${s.rotate}deg) scale(${s.scaleX}, ${s.scaleY})`;
const filterOf = (s) => s.filter || "none";

const textUnits = (value, type) => {
  const text = String(value || "").trim();
  if (!text) return 0;
  return type === "word"
    ? text.split(/\s+/).length
    : [...text.replace(/\s+/g, "")].length;
};

/** Keyframes and the end state for one item, from the state before it. */
function planItem(item, state, piece, frame, reduced) {
  const { effect } = item;
  const cls = effect.presetClass;
  const next = { ...state };
  const out = [];
  if (cls === "entr" || cls === "exit") {
    const frames = entranceFrames(effect, piece.box, frame);
    const entering = cls === "entr";
    next.visible = entering;
    const kf = reduced
      ? [
          { visibility: "visible", opacity: 0 },
          { visibility: "visible", opacity: 1 },
        ]
      : frames;
    out.push({
      layer: "fx",
      keyframes: entering
        ? kf
        : [...kf].reverse().map((f) => ({
            ...f,
            ...(f.offset !== undefined ? { offset: 1 - f.offset } : {}),
          })),
      duration: reduced ? Math.min(200, effect.durationMs) : effect.durationMs,
    });
    // Text a word or letter at a time: the text is uncovered in steps from
    // its start, one step per word or letter.
    const count =
      effect.iterate && !reduced
        ? textUnits(piece.text, effect.iterate.type)
        : 0;
    if (count > 1) {
      const b = piece.box;
      const shown = `inset(0 ${pct(1 - b.x - b.w)} 0 0)`;
      const hidden = `inset(0 ${pct(1 - b.x)} 0 0)`;
      const steps = entering ? [hidden, shown] : [shown, hidden];
      out.push({
        layer: "iter",
        keyframes: steps.map((clipPath) => ({ clipPath })),
        duration:
          effect.durationMs *
          (1 + ((count - 1) * effect.iterate.delayPercent) / 100),
        easing: `steps(${count}, ${entering ? "start" : "end"})`,
      });
    }
  } else if (cls === "emph") {
    const id = effect.presetId;
    const base = { transform: emphTransform(state), opacity: state.opacity };
    let frames = null;
    const dur = effect.durationMs;
    switch (id) {
      case 8:
        next.rotate = state.rotate + (effect.amount ?? 360);
        break;
      case 6: {
        const k = (effect.amount ?? 150) / 100;
        next.scaleX = state.scaleX * k;
        next.scaleY = state.scaleY * k;
        break;
      }
      case 9:
        next.opacity = Math.max(0, 1 - (effect.amount ?? 50) / 100);
        break;
      case 25:
        next.filter = "grayscale(1)";
        break;
      case 24:
        next.filter = "brightness(0.65)";
        break;
      case 30:
        next.filter = "brightness(1.35) saturate(0.85)";
        break;
      case 15:
        next.filter = "drop-shadow(0 0 0.6px rgba(0,0,0,.9))";
        break;
      case 1:
      case 3:
      case 7:
      case 19:
        next.tint = `#${effect.color || "E81224"}`;
        break;
      case 18:
        next.underline = true;
        break;
      case 26: {
        const up = {
          ...state,
          scaleX: state.scaleX * 1.06,
          scaleY: state.scaleY * 1.06,
        };
        frames = [base, { transform: emphTransform(up), offset: 0.5 }, base];
        break;
      }
      case 32: {
        frames = [0, 4, -4, 4, -4, 0].map((a) => ({
          transform: emphTransform({ ...state, rotate: state.rotate + a }),
        }));
        break;
      }
      case 34: {
        frames = [0, -1, 0, 1, 0].map((k) => ({
          transform: `translate(0, ${k * 3}%) ${emphTransform(state)}`,
        }));
        break;
      }
      case 10:
        frames = [
          { filter: filterOf(state) },
          {
            filter: "drop-shadow(0 0 0.8px rgba(0,0,0,.9)) contrast(1.3)",
            offset: 0.2,
          },
          {
            filter: "drop-shadow(0 0 0.8px rgba(0,0,0,.9)) contrast(1.3)",
            offset: 0.8,
          },
          { filter: filterOf(state) },
        ];
        break;
      case 35:
        frames = [
          { opacity: state.opacity },
          { opacity: 0, offset: 0.25 },
          { opacity: state.opacity, offset: 0.5 },
          { opacity: 0, offset: 0.75 },
          { opacity: state.opacity },
        ];
        break;
      case 27: {
        out.push({
          layer: "tint",
          keyframes: [
            { opacity: 0, backgroundColor: `#${effect.color || "E81224"}` },
            {
              opacity: 0.85,
              offset: 0.5,
              backgroundColor: `#${effect.color || "E81224"}`,
            },
            { opacity: 0, backgroundColor: `#${effect.color || "E81224"}` },
          ],
          duration: dur,
        });
        break;
      }
      default:
        if (!entryFor(effect)) {
          const up = {
            ...state,
            scaleX: state.scaleX * 1.05,
            scaleY: state.scaleY * 1.05,
          };
          frames = [base, { transform: emphTransform(up), offset: 0.5 }, base];
        }
    }
    if (!frames && !out.length) {
      if (next.rotate !== state.rotate || next.scaleX !== state.scaleX)
        frames = [base, { transform: emphTransform(next) }];
      else if (next.opacity !== state.opacity)
        frames = [{ opacity: state.opacity }, { opacity: next.opacity }];
      else if (next.filter !== state.filter)
        frames = [{ filter: filterOf(state) }, { filter: filterOf(next) }];
      else if (next.tint !== state.tint)
        out.push({
          layer: "tint",
          keyframes: [
            {
              opacity: state.tint ? 1 : 0,
              backgroundColor: state.tint || next.tint,
            },
            { opacity: 1, backgroundColor: next.tint },
          ],
          duration: dur,
        });
      else if (next.underline !== state.underline)
        out.push({
          layer: "underline",
          keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
          duration: dur,
        });
    }
    if (frames)
      out.push({
        layer: "emph",
        keyframes: frames,
        duration: dur,
      });
    if (reduced) out.length = 0;
  } else if (cls === "path") {
    const d =
      effect.path || P.motionPathFor(effect.presetId, effect.presetSubtype);
    const [ex, ey] = pathEnd(d);
    next.tx = state.tx + ex;
    next.ty = state.ty + ey;
    if (!reduced)
      out.push({
        layer: "motion",
        keyframes: samplePath(d).map(([x, y]) => ({
          transform: `translate(${pct(state.tx + x)}, ${pct(state.ty + y)})`,
        })),
        duration: effect.durationMs,
      });
  }
  if (effect.after) {
    if (effect.after.kind === "hide") next.visible = false;
    else if (effect.after.kind === "dim") next.dim = `#${effect.after.color}`;
    // "hideOnClick" hides when the next click group starts (see hideAfter).
  }
  if (effect.rewind) return { animations: out, end: { ...state } };
  return { animations: out, end: next };
}

const INITIAL = {
  visible: true,
  tx: 0,
  ty: 0,
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  filter: "",
  tint: "",
  underline: false,
  dim: "",
};

function easingOf(effect) {
  const a = effect.smoothStart || 0,
    d = effect.smoothEnd || 0;
  if (effect.bounceEnd)
    return "linear(0, 0.36 30%, 0.74 50%, 1 62%, 0.86 70%, 1 80%, 0.95 88%, 1)";
  if (!a && !d) return "linear";
  return `cubic-bezier(${(a * 0.6).toFixed(3)}, 0, ${(1 - d * 0.6).toFixed(3)}, 1)`;
}

// ---------------------------------------------------------------------------
// The player.

/**
 * createAnimationPlayer({ pres, slide, frame, renderLayer, effects?,
 *   reducedMotion? })
 *
 * `frame` is a positioned element the size of the slide; the player adds
 * its pictures to it. `renderLayer(layer)` returns an image URL for a layer
 * of the slide (see model.js `preview`).
 */
export function createAnimationPlayer({
  pres,
  slide,
  frame,
  renderLayer,
  effects = P.getSlideAnimations(slide),
  reducedMotion = prefersReducedMotion(),
  onChange = null,
  sounds = true,
}) {
  const mainEffects = effects.filter((e) => e.trigger === undefined);
  const mainItems = expandItems(slide, mainEffects);
  const groups = buildSequence(mainItems);
  const triggerSeqs = new Map();
  for (const e of effects)
    if (e.trigger !== undefined && !triggerSeqs.has(e.trigger))
      triggerSeqs.set(e.trigger, {
        groups: buildSequence(
          expandItems(
            slide,
            effects.filter((x) => x.trigger === e.trigger),
          ),
          { main: false },
        ),
        next: 0,
      });
  const allItems = [
    ...mainItems,
    ...[...triggerSeqs.values()].flatMap((s) =>
      s.groups.flatMap((g) => g.items),
    ),
  ];
  const runs = piecesOf(pres, slide, allItems);
  const root = document.createElement("div");
  root.className = "anim-stage";
  root.setAttribute("aria-hidden", "true");
  const pieces = [];
  for (const run of runs) {
    const img = new Image();
    img.className = "anim-layer-img";
    img.alt = "";
    img.draggable = false;
    if (run.kind === "static") {
      const first = runs.indexOf(run) === 0;
      img.src = renderLayer({
        background: first,
        shape: (s) => run.shapes.get(String(P.getShapeId(s))) ?? false,
      });
      img.classList.add("anim-static");
      root.append(img);
      continue;
    }
    if (runs.indexOf(run) === 0) {
      const bg = new Image();
      bg.className = "anim-layer-img anim-static";
      bg.alt = "";
      bg.src = renderLayer({ background: true, shape: () => false });
      root.append(bg);
    }
    img.src = renderLayer({
      background: false,
      shape: (s) =>
        String(P.getShapeId(s)) === run.shapeId ? run.layer : false,
    });
    const motion = div("anim-motion");
    const emph = div("anim-emph");
    const fx = div("anim-fx");
    const iter = div("anim-iter");
    const tint = div("anim-tint");
    const dim = div("anim-tint anim-dim");
    tint.style.maskImage = tint.style.webkitMaskImage = `url("${img.src}")`;
    dim.style.maskImage = dim.style.webkitMaskImage = `url("${img.src}")`;
    const underline = div("anim-underline");
    const b = run.box;
    Object.assign(underline.style, {
      left: pct(b.x),
      width: pct(b.w),
      top: pct(b.y + b.h),
    });
    const origin = `${pct(b.x + b.w / 2)} ${pct(b.y + b.h / 2)}`;
    emph.style.transformOrigin = origin;
    fx.style.transformOrigin = origin;
    fx.append(img, tint, dim, underline);
    iter.append(fx);
    emph.append(iter);
    motion.append(emph);
    root.append(motion);
    pieces.push({
      ...run,
      key: `${run.shapeId}:${run.part}`,
      els: { motion, emph, iter, fx, tint, dim, underline, img },
      state: { ...INITIAL },
      initial: null,
    });
  }
  frame.append(root);

  const piecesFor = (item) =>
    pieces.filter(
      (p) =>
        p.shapeId === item.shapeId &&
        (item.part === null
          ? true
          : item.part === "bg"
            ? p.part === "bg"
            : item.part.includes(p.part)),
    );
  // Each piece starts hidden when the first thing that happens to it is an
  // entrance.
  for (const piece of pieces) {
    const first = allItems.find((it) => piecesFor(it).includes(piece));
    piece.initial = {
      ...INITIAL,
      visible: first?.effect.presetClass !== "entr",
    };
  }
  const apply = (piece) => {
    const s = piece.state;
    const { motion, emph, fx, tint, dim, underline } = piece.els;
    motion.style.transform = `translate(${pct(s.tx)}, ${pct(s.ty)})`;
    emph.style.transform = emphTransform(s);
    emph.style.opacity = String(s.opacity);
    emph.style.filter = filterOf(s);
    fx.style.visibility = s.visible ? "visible" : "hidden";
    tint.style.opacity = s.tint ? "1" : "0";
    tint.style.backgroundColor = s.tint || "transparent";
    dim.style.opacity = s.dim ? "1" : "0";
    dim.style.backgroundColor = s.dim || "transparent";
    underline.style.transform = s.underline ? "scaleX(1)" : "scaleX(0)";
  };
  // Bumped on every reset, so effects finishing late (after a seek) do not
  // put their end state over the new one.
  let epoch = 0;
  const reset = () => {
    epoch++;
    for (const p of pieces) {
      p.state = { ...p.initial };
      apply(p);
    }
    for (const seq of triggerSeqs.values()) seq.next = 0;
  };

  let running = []; // { animations, done }
  let step = 0; // click groups played (auto group counted as 0)
  const frameSize = () => {
    const r = frame.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1 };
  };

  // Plays a group; resolves when it ends. `instant` applies its end state.
  function playGroup(group, { instant = false } = {}) {
    const size = frameSize();
    const items = [...group.items].sort((a, b) => a.at - b.at);
    const scheduled = [];
    const planned = new Map(pieces.map((p) => [p, p.state]));
    for (const item of items) {
      for (const piece of piecesFor(item)) {
        const plan = planItem(
          item,
          planned.get(piece),
          piece,
          size,
          reducedMotion,
        );
        planned.set(piece, plan.end);
        scheduled.push({ item, piece, plan });
      }
    }
    if (instant || !scheduled.length) {
      for (const [piece, state] of planned) {
        piece.state = state;
        apply(piece);
      }
      return Promise.resolve();
    }
    // Effect sounds start with their effect (once per effect).
    for (const item of items)
      if (item.effect.sound && item.sub === 0 && sounds) {
        const id = setTimeout(() => {
          soundTimers.delete(id);
          let data = null;
          try {
            data = P.getSlideAnimationSoundData(slide, item.effect.sound.relId);
          } catch {}
          if (data && alive) playEffectSound(data.bytes);
        }, item.at);
        soundTimers.add(id);
      }
    const entries = scheduled.map(({ item, piece, plan }) => {
      const effect = item.effect;
      const iterations =
        effect.repeat === "untilNextClick" ||
        effect.repeat === "untilEndOfSlide"
          ? Infinity
          : typeof effect.repeat === "number"
            ? effect.repeat
            : 1;
      const animations = plan.animations.map((a) =>
        piece.els[a.layer].animate(a.keyframes, {
          duration: Math.max(1, a.duration),
          delay: item.at,
          iterations: effect.autoReverse ? iterations * 2 : iterations,
          direction: effect.autoReverse ? "alternate" : "normal",
          easing: a.easing || easingOf(effect),
          fill: "both",
        }),
      );
      const born = epoch;
      let settled = false;
      const settle = () => {
        if (born !== epoch || settled) return;
        settled = true;
        piece.state = plan.end;
        apply(piece);
        for (const a of animations) a.cancel();
      };
      // An effect without motion (Appear, an instant emphasis) changes its
      // state when its time comes.
      const timer =
        animations.length === 0
          ? setTimeout(settle, item.at + (effect.durationMs || 0))
          : null;
      const finite = animations.filter((a) => {
        const t = a.effect?.getComputedTiming?.();
        return !t || Number.isFinite(t.endTime);
      });
      const done = Promise.all(
        finite.map((a) => a.finished.catch(() => {})),
      ).then(() => {
        if (animations.length && finite.length === animations.length) settle();
      });
      return {
        animations,
        timer,
        settle,
        done: timer ? delay(item.at + (effect.durationMs || 0)) : done,
        // Repeating until the end of the slide outlasts the next click.
        endless:
          finite.length !== animations.length
            ? effect.repeat === "untilEndOfSlide"
              ? "slide"
              : "click"
            : null,
      };
    });
    running = entries;
    return Promise.all(entries.map((e) => e.done)).then(() => {
      if (running === entries) {
        running = entries.filter((e) => e.endless === "click");
        lasting.push(...entries.filter((e) => e.endless === "slide"));
      }
      onChange?.();
    });
  }
  let lasting = [];
  function stopLasting() {
    for (const entry of lasting) {
      entry.animations.forEach((a) => a.cancel());
      entry.settle();
    }
    lasting = [];
  }
  function finishRunning() {
    for (const entry of running) {
      if (entry.endless) {
        entry.animations.forEach((a) => a.cancel());
        entry.settle();
        continue;
      }
      clearTimeout(entry.timer);
      for (const a of entry.animations) {
        try {
          a.finish();
        } catch {
          a.cancel();
        }
      }
      entry.settle();
    }
    running = [];
  }

  // Shapes set to hide on the next click hide as the next group starts.
  function hideAfter(group) {
    if (!group) return;
    for (const item of group.items)
      if (item.effect.after?.kind === "hideOnClick" && !item.effect.rewind)
        for (const piece of piecesFor(item)) {
          piece.state = { ...piece.state, visible: false };
          apply(piece);
        }
  }
  const soundTimers = new Set();
  const stopSounds = () => {
    for (const id of soundTimers) clearTimeout(id);
    soundTimers.clear();
    stopEffectSounds();
  };

  const autoStart = groups[0]?.auto ? 1 : 0;
  let played = Promise.resolve();
  const api = {
    /** Click steps (the main sequence's groups after any automatic one). */
    steps: groups.length - autoStart,
    get step() {
      return step;
    },
    get playing() {
      return running.some((e) => !e.endless);
    },
    /** Settles when the step last started by next() ends. */
    get played() {
      return played;
    },
    effects,
    groups,
    /** Shapes that start effects when clicked: ids and boxes (0..1). */
    triggers: [...triggerSeqs.keys()].map((id) => {
      const shape = P.findShapeById(slide, Number(id));
      const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
      const b = shape ? slideBounds(pres, shape) : null;
      return {
        shapeId: id,
        box: b
          ? {
              x: b.x / size.width,
              y: b.y / size.height,
              w: b.w / size.width,
              h: b.h / size.height,
            }
          : null,
      };
    }),
    start() {
      finishRunning();
      reset();
      step = 0;
      if (autoStart) return playGroup(groups[0]);
      return Promise.resolve();
    },
    next() {
      if (running.length) finishRunning();
      const index = step + autoStart;
      if (index >= groups.length) return false;
      step++;
      hideAfter(groups[index - 1]);
      played = playGroup(groups[index]);
      return true;
    },
    previous() {
      finishRunning();
      if (step === 0) return false;
      api.seek(step - 1);
      return true;
    },
    /** Shows the state after `n` click steps at once. */
    seek(n) {
      stopSounds();
      finishRunning();
      stopLasting();
      reset();
      step = Math.max(0, Math.min(n, api.steps));
      for (let i = 0; i < step + autoStart; i++) {
        hideAfter(groups[i - 1]);
        playGroup(groups[i], { instant: true });
      }
    },
    finish() {
      api.seek(api.steps);
    },
    playTrigger(shapeId) {
      const seq = triggerSeqs.get(String(shapeId));
      if (!seq || !seq.groups.length) return false;
      if (running.length) finishRunning();
      if (seq.next >= seq.groups.length) seq.next = 0;
      playGroup(seq.groups[seq.next++]);
      return true;
    },
    /** Plays the main sequence (and triggers) through without clicks. */
    async playAll({ from = 0 } = {}) {
      api.seek(0);
      let i = 0;
      for (const group of groups) {
        if (!alive) return;
        hideAfter(groups[i - 1]);
        if (i++ < from) {
          await playGroup(group, { instant: true });
          continue;
        }
        await playGroup(group);
      }
      for (const seq of triggerSeqs.values())
        for (const group of seq.groups) {
          if (!alive) return;
          await playGroup(group);
        }
    },
    /** The stage element the player draws into. */
    element: root,
    /** One picture of the slide as it stands (positions aside). */
    snapshot(render) {
      const parts = new Map();
      const add = (id, part) => {
        if (part === false) return;
        const had = parts.get(id);
        if (part === true || had === true) return parts.set(id, true);
        parts.set(id, {
          body: !!had?.body || part.body,
          paragraphs: new Set([
            ...(had?.paragraphs ?? []),
            ...(part.paragraphs ?? []),
          ]),
        });
      };
      for (const run of runs)
        if (run.kind === "static")
          for (const [id, part] of run.shapes) add(id, part);
      for (const piece of pieces)
        if (piece.state.visible) add(piece.shapeId, piece.layer);
      return render({
        background: true,
        shape: (s) => parts.get(String(P.getShapeId(s))) ?? false,
      });
    },
    destroy() {
      alive = false;
      stopSounds();
      stopLasting();
      for (const entry of running) {
        clearTimeout(entry.timer);
        entry.animations.forEach((a) => a.cancel());
      }
      running = [];
      root.remove();
    },
  };
  let alive = true;
  reset();
  return api;
}

function div(className) {
  const node = document.createElement("div");
  node.className = className;
  return node;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
