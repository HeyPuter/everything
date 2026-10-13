/**
 * Pure geometry of the makeup tools (model/retouch.js, engine/face-render.js):
 * where blush, eyeshadow, eyeliner, brow tint, contour and highlight go on a
 * face, drawn from its landmarks as soft region masks. Lips use the skin fix
 * masks (face-geometry.js).
 *
 * Faces are Float32Arrays of x, y pairs in source pixels (y down), indexed
 * like the face landmarker's mesh; "A" is the side on the left of the
 * picture for a face looking at the camera (see face-geometry.js).
 */
import { LM, faceFrame, fillPolygon, blurMask, bounds, scaled, ellipsePoly, maskFrame, packChannels } from './face-geometry.js';

const P = (pts, i) => [pts[i * 2], pts[i * 2 + 1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const add = (a, v, k = 1) => [a[0] + v[0] * k, a[1] + v[1] * k];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const perp = (v) => [-v[1], v[0]];
const mean = (pts, ids) => {
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return [x / ids.length, y / ids.length];
};

/** A soft band (ellipse) from a to b, half as thick as `half`. */
function band(a, b, half) {
  const ax = unit([b[0] - a[0], b[1] - a[1]]);
  return ellipsePoly(lerp(a, b, 0.5), ax, dist(a, b) / 2 || half, perp(ax), half);
}

/** The two eyes of a face: the upper lid from the outer corner in, its sides and which way is out. */
function eyes(pts, ux) {
  return [
    { ids: LM.eyeA, lid: LM.eyeA.slice(0, 9), brow: LM.browA.slice(5), out: [-ux[0], -ux[1]], mouth: LM.mouthA, side: LM.sideA, temple: 54, wing: LM.wingA, inner: 133 },
    { ids: LM.eyeB, lid: LM.eyeB.slice(0, 9), brow: LM.browB.slice(5), out: ux, mouth: LM.mouthB, side: LM.sideB, temple: 284, wing: LM.wingB, inner: 362 },
  ].map((e) => {
    const lid = e.lid.map((i) => P(pts, i));
    return { ...e, lidPts: lid, center: mean(pts, e.ids), browLow: mean(pts, e.brow), width: dist(lid[0], lid[lid.length - 1]) || 1 };
  });
}

/** Eyeshadow on the upper lid: the lash line up toward the brow, highest mid-lid, swept out at the outer corner. */
function lidShadow(e, up) {
  const n = e.lidPts.length - 1;
  // Never up into the brow: lower lids sit closer to some brows than others.
  const top0 = e.lidPts[n >> 1];
  const room = (e.browLow[0] - top0[0]) * up[0] + (e.browLow[1] - top0[1]) * up[1] - e.width * 0.1;
  const k = clamp(room / (e.width * 0.46), 0.3, 1);
  const top = e.lidPts.map((p, i) => {
    const t = i / n;
    return add(add(p, up, e.width * k * (0.16 + 0.3 * Math.sin(Math.PI * t))), e.out, e.width * 0.12 * (1 - t) * (1 - t));
  });
  const tip = add(add(e.lidPts[0], e.out, e.width * 0.2), up, e.width * 0.12);
  return [tip, ...e.lidPts, ...top.reverse()].flat();
}

/** Eyeliner along the upper lash line, thicker toward the outer corner, with a small wing. */
function lashLine(e, up) {
  const n = e.lidPts.length - 1;
  const lower = e.lidPts.map((p) => add(p, up, e.width * 0.005));
  const upper = e.lidPts.map((p, i) => add(p, up, e.width * (0.03 + 0.05 * (1 - i / n))));
  const tip = add(add(e.lidPts[0], e.out, e.width * 0.22), up, e.width * 0.1);
  return [tip, ...lower, ...upper.reverse()].flat();
}

/**
 * Polygons (source pixels) of the makeup regions of one face: blush on the
 * cheeks, eyeshadow on the lids, eyeliner on the lash lines, the brows,
 * contour (under the cheekbones, temples, sides of the nose, jaw) and
 * highlight (cheekbones, nose bridge, forehead, chin, above the lip). eyes
 * are the eye openings, kept free of shadow and liner.
 */
export function makeupRegions(pts) {
  const { ux, uy, width: fw } = faceFrame(pts);
  const up = [-uy[0], -uy[1]];
  const both = eyes(pts, ux);
  const bridge = lerp(P(pts, 133), P(pts, 362), 0.5);
  const out = { blush: [], shadow: [], liner: [], brows: [], contour: [], highlight: [], eyes: [], width: fw };
  for (const e of both) {
    const mouth = P(pts, e.mouth);
    const side = P(pts, e.side);
    const outer = e.lidPts[0];
    // Blush on the apple of the cheek, swept up toward the temple.
    const drop = Math.max(fw * 0.12, (mouth[0] - e.center[0]) * uy[0] + (mouth[1] - e.center[1]) * uy[1]);
    const apple = add(add(e.center, uy, drop * 0.55), e.out, fw * 0.06);
    const sweep = unit([side[0] - apple[0] - uy[0] * fw * 0.1, side[1] - apple[1] - uy[1] * fw * 0.1]);
    out.blush.push(ellipsePoly(apple, sweep, fw * 0.17, perp(sweep), fw * 0.105));
    out.shadow.push(lidShadow(e, up));
    out.liner.push(lashLine(e, up));
    out.eyes.push(e.ids.flatMap((i) => P(pts, i)));
    // Contour: the hollow under the cheekbone, the temple, the side of the nose and the jaw.
    const hollow = add(add(side, uy, fw * 0.1), e.out, -fw * 0.03);
    out.contour.push(band(hollow, lerp(hollow, mouth, 0.5), fw * 0.04));
    out.contour.push(ellipsePoly(add(P(pts, e.temple), e.out, -fw * 0.04), uy, fw * 0.07, ux, fw * 0.04));
    out.contour.push(band(add(lerp(bridge, P(pts, e.inner), 0.42), uy, fw * 0.02), P(pts, e.wing), fw * 0.022));
    // Highlight on top of the cheekbone.
    const bone = add(lerp(outer, side, 0.4), uy, fw * 0.1);
    const along = unit([side[0] - outer[0], side[1] - outer[1]]);
    out.highlight.push(ellipsePoly(bone, along, fw * 0.11, perp(along), fw * 0.035));
  }
  out.brows.push(scaled(pts, LM.browA, 1.06), scaled(pts, LM.browB, 1.06));
  for (const jaw of [LM.jawA, LM.jawB]) {
    const edge = jaw.map((i) => P(pts, i));
    const c = mean(pts, [LM.noseTip, LM.chin]);
    const inner = edge.map((p) => lerp(p, c, (fw * 0.07) / (dist(p, c) || 1)));
    out.contour.push([...edge, ...inner.reverse()].flat());
  }
  // Highlight down the nose bridge, the middle of the forehead, the chin and above the upper lip.
  out.highlight.push(band(add(bridge, uy, fw * 0.04), add(P(pts, LM.noseTip), uy, -fw * 0.03), fw * 0.02));
  const brow = add(lerp(P(pts, LM.browA[4]), P(pts, LM.browB[4]), 0.5), up, fw * 0.16);
  out.highlight.push(ellipsePoly(brow, uy, fw * 0.1, ux, fw * 0.07));
  out.highlight.push(ellipsePoly(add(P(pts, LM.chin), up, fw * 0.08), ux, fw * 0.05, uy, fw * 0.04));
  out.highlight.push(ellipsePoly(add(P(pts, 0), up, fw * 0.015), ux, fw * 0.035, uy, fw * 0.012));
  return out;
}

/** Blur radius of each makeup region, in face widths. */
const SOFTNESS = { blush: 0.05, shadow: 0.022, liner: 0.004, brows: 0.006, contour: 0.035, highlight: 0.03 };

/**
 * Makeup region masks for the faces of a frame over rect = [x, y, w, h] of
 * the source (rows top first), as two RGBA byte images: color (R blush, G
 * eyeshadow, B eyeliner, A brows) and sculpt (R contour, G highlight).
 * null without faces.
 */
export function makeupMasks(faces, srcW, srcH, { maxSide = 384 } = {}) {
  const frame = maskFrame(faces, srcW, srcH, maxSide);
  if (!frame) return null;
  const { width: w, height: h, k, to } = frame;
  const keys = ['blush', 'shadow', 'liner', 'brows', 'contour', 'highlight'];
  const ch = Object.fromEntries(keys.map((key) => [key, new Float32Array(w * h)]));
  const drawn = Object.fromEntries(keys.map((key) => [key, []]));
  const eyesCut = [];
  let fw = 0;
  for (const r of faces.map(makeupRegions)) {
    for (const key of keys) {
      for (const poly of r[key]) {
        const p = to(poly);
        fillPolygon(ch[key], w, h, p);
        drawn[key].push(p);
      }
    }
    eyesCut.push(...r.eyes.map(to));
    fw = Math.max(fw, r.width * k);
  }
  for (const key of keys) blurMask(ch[key], w, h, fw * SOFTNESS[key], bounds(drawn[key]));
  // Shadow and liner stop crisply at the eye opening, like the lid does.
  for (const p of eyesCut) {
    fillPolygon(ch.shadow, w, h, p, 'cut');
    fillPolygon(ch.liner, w, h, p, 'cut');
  }
  return {
    rect: frame.rect,
    width: w,
    height: h,
    color: packChannels([ch.blush, ch.shadow, ch.liner, ch.brows], w, h),
    sculpt: packChannels([ch.contour, ch.highlight, null, null], w, h),
  };
}
