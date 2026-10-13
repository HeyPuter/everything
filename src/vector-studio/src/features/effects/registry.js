/**
 * The vector effects of the Effect menu: their geometry (registered with
 * the geometry effect registry, so rendering, hit testing, bounds, export
 * and Expand Appearance pick them up) and their records (labels, defaults,
 * ranges for the effect model). Importing this module registers them; it
 * has no UI, so exporters and tests can use it on its own.
 *
 * Fractions are stored as fractions (0.5 = 50%), lengths in points, angles
 * in degrees.
 */
import { registerGeomEffect } from '../../model/geom-effects.js';
import { warpSubpaths, WARP_STYLES, WARP_DEFAULTS, isWarpStyle } from '../../model/warp.js';
import { registerEffectType, EFFECTS } from '../paint/effects-model.js';
import { freeDistort, puckerBloat, roughen, transformEffect, tweak, twist, zigzag, newSeed, SQUARE_CORNERS } from './geom/distort.js';
import { convertToShape, cropMarks } from './geom/shapes.js';
import { scribble, SCRIBBLE_PRESETS } from './geom/scribble.js';
import { offsetPath, outlineStroke, pathfinderOnShape, pathfinderCombine, PATHFINDER_EFFECTS } from './geom/engine.js';

const seeded = (p) => ({ ...p, seed: Number.isFinite(p.seed) && p.seed !== 0 ? p.seed : newSeed() });

const DEFS = {
  freeDistort: {
    label: 'Free Distort',
    command: 'effect.freeDistort',
    defaults: { corners: SQUARE_CORNERS.map((c) => ({ ...c })) },
    normalize(out) {
      const ok = Array.isArray(out.corners) && out.corners.length === 4 && out.corners.every((c) => Number.isFinite(c?.x) && Number.isFinite(c?.y));
      out.corners = ok ? out.corners.map((c) => ({ x: Math.max(-10, Math.min(11, c.x)), y: Math.max(-10, Math.min(11, c.y)) })) : SQUARE_CORNERS.map((c) => ({ ...c }));
      return out;
    },
    apply: (subs, fx, info) => freeDistort(subs, fx, info.bounds),
  },
  puckerBloat: {
    label: 'Pucker & Bloat',
    command: 'effect.pucker',
    defaults: { amount: 0.3 },
    ranges: { amount: [-2, 2] },
    describe: (e) => (e.amount < 0 ? `Pucker ${Math.round(-e.amount * 100)}%` : `Bloat ${Math.round(e.amount * 100)}%`),
    apply: (subs, fx, info) => puckerBloat(subs, fx, info.bounds),
  },
  roughen: {
    label: 'Roughen',
    command: 'effect.roughen',
    defaults: { size: 0.05, relative: true, detail: 10, smooth: true, seed: 0 },
    ranges: { size: [0, 1000], detail: [0, 100], seed: [0, 0x7fffffff] },
    init: seeded,
    apply: (subs, fx, info) => roughen(subs, fx, info.bounds),
  },
  transform: {
    label: 'Transform',
    command: 'effect.transform',
    defaults: { scaleH: 1, scaleV: 1, moveH: 0, moveV: 0, angle: 0, reflectX: false, reflectY: false, origin: [0.5, 0.5], copies: 0, random: false, seed: 0, scaleStrokes: false },
    ranges: { scaleH: [-20, 20], scaleV: [-20, 20], moveH: [-100000, 100000], moveV: [-100000, 100000], angle: [-3600, 3600], copies: [0, 1000], seed: [0, 0x7fffffff] },
    init: seeded,
    normalize(out) {
      const o = Array.isArray(out.origin) ? out.origin : [0.5, 0.5];
      out.origin = [0, 1].map((i) => ([0, 0.5, 1].includes(o[i]) ? o[i] : 0.5));
      out.copies = Math.round(out.copies);
      return out;
    },
    apply: (subs, fx, info) => transformEffect(subs, fx, info.bounds, info.node?.stroke ? info.node.strokeWidth : 0),
  },
  tweak: {
    label: 'Tweak',
    command: 'effect.tweak',
    defaults: { h: 0.1, v: 0.1, relative: true, anchors: true, inHandles: true, outHandles: true, seed: 0 },
    ranges: { h: [0, 10000], v: [0, 10000], seed: [0, 0x7fffffff] },
    init: seeded,
    apply: (subs, fx, info) => tweak(subs, fx, info.bounds),
  },
  twist: {
    label: 'Twist',
    command: 'effect.twist',
    defaults: { angle: 30 },
    ranges: { angle: [-3600, 3600] },
    apply: (subs, fx, info) => twist(subs, fx, info.bounds),
  },
  zigzag: {
    label: 'Zig Zag',
    command: 'effect.zigzag',
    defaults: { size: 10, relative: false, ridges: 4, smooth: false },
    ranges: { size: [0, 10000], ridges: [0, 100] },
    normalize(out) {
      out.ridges = Math.round(out.ridges);
      return out;
    },
    apply: (subs, fx, info) => zigzag(subs, fx, info.bounds),
  },
  offsetPath: {
    label: 'Offset Path',
    command: 'effect.offsetPath',
    defaults: { offset: 10, joins: 'miter', miterLimit: 4 },
    ranges: { offset: [-10000, 10000], miterLimit: [1, 500] },
    enums: { joins: ['miter', 'round', 'bevel'] },
    apply: offsetPath,
  },
  outlineObject: {
    label: 'Outline Object',
    command: 'effect.outlineObject',
    noDialog: true,
    defaults: {},
    // Type draws as its glyph outlines (see text-effects.js); paths already are outlines.
    apply: (subs) => subs,
  },
  outlineStroke: {
    label: 'Outline Stroke',
    command: 'effect.outlineStroke',
    noDialog: true,
    defaults: {},
    apply: outlineStroke,
  },
  convertShape: {
    label: 'Convert to Shape',
    command: 'effect.shape.rectangle',
    defaults: { shape: 'rectangle', sizeMode: 'relative', width: 72, height: 72, extraW: 18, extraH: 18, radius: 9 },
    ranges: { width: [0, 100000], height: [0, 100000], extraW: [-10000, 10000], extraH: [-10000, 10000], radius: [0, 10000] },
    enums: { shape: ['rectangle', 'roundedRectangle', 'ellipse'], sizeMode: ['relative', 'absolute'] },
    describe: (e) => ({ rectangle: 'Rectangle', roundedRectangle: 'Rounded Rectangle', ellipse: 'Ellipse' })[e.shape],
    apply: (subs, fx, info) => convertToShape(subs, fx, info.bounds),
  },
  warp: {
    label: 'Warp',
    command: 'effect.warp.arc',
    defaults: { ...WARP_DEFAULTS },
    ranges: { bend: [-1, 1], distortH: [-1, 1], distortV: [-1, 1] },
    enums: { style: WARP_STYLES.map((s) => s.id) },
    describe: (e) => `Warp: ${WARP_STYLES.find((s) => s.id === e.style)?.label || 'Arc'}`,
    apply: (subs, fx, info) => warpSubpaths(subs, isWarpStyle(fx.style) ? fx.style : 'arc', fx, info.bounds),
  },
  scribble: {
    label: 'Scribble',
    command: 'effect.scribble',
    defaults: { preset: 'default', ...withoutMeta(SCRIBBLE_PRESETS[0]), seed: 0 },
    ranges: { angle: [-360, 360], overlap: [-1000, 1000], overlapVar: [0, 1000], lineWidth: [0.01, 1000], curviness: [0, 1], curvinessVar: [0, 1], spacing: [0.1, 1000], spacingVar: [0, 1000], seed: [0, 0x7fffffff] },
    enums: { preset: ['custom', ...SCRIBBLE_PRESETS.map((p) => p.id)] },
    init: seeded,
    apply: (subs, fx, info) => scribble(subs, fx, info.bounds, { evenodd: info.node?.fillRule === 'evenodd' }),
    // Result bounds cover the passes' centerlines; the lines reach half their width past them.
    outset: (fx) => fx.lineWidth / 2,
  },
  cropMarks: {
    label: 'Crop Marks',
    command: 'effect.cropMarks',
    noDialog: true,
    defaults: { gap: 9, length: 18 },
    ranges: { gap: [0, 1000], length: [0.1, 1000] },
    apply: (subs, fx, info) => cropMarks(subs, fx, info.bounds),
    outset: () => 0.15,
  },
  pathfinder: {
    label: 'Pathfinder',
    command: 'effect.pathfinder.unite',
    noDialog: true,
    defaults: { kind: 'unite' },
    enums: { kind: PATHFINDER_EFFECTS.map((k) => k.kind) },
    describe: (e) => `Pathfinder: ${PATHFINDER_EFFECTS.find((k) => k.kind === e.kind)?.label || 'Add'}`,
    apply: pathfinderOnShape,
    combine: pathfinderCombine,
  },
};

function withoutMeta(preset) {
  const { id, label, ...rest } = preset;
  return rest;
}

/** Record types of the vector effects. */
export const VECTOR_EFFECT_TYPES = Object.keys(DEFS);

for (const [type, def] of Object.entries(DEFS)) {
  const { apply, outset, combine, ...meta } = def;
  registerGeomEffect(type, { apply, outset, combine });
  registerEffectType(type, meta);
}

export { EFFECTS };
