// The flat pattern of a sheet metal part as 2D geometry (computed by the
// geometry worker from the sheet metal features), and its DXF export.
// Coordinates are millimetres in the flat pattern's own plane.

import type { Frame, Vec2 } from '../math/vec';
import type { Id } from './types';

export type FlatSeg =
  | { k: 'line'; a: Vec2; b: Vec2 }
  /** Counter-clockwise from a0 to a1 (radians). */
  | { k: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  | { k: 'circle'; c: Vec2; r: number };

export interface FlatLoop {
  /** The outline of a region (else a hole or cut inside it). */
  outer: boolean;
  segs: FlatSeg[];
}

export interface FlatBend {
  /** Bend centre line, from a to b. */
  a: Vec2;
  b: Vec2;
  /** Bends toward the viewer of the flat pattern (its top face). */
  up: boolean;
  angle: number;
  /** Inner radius. */
  radius: number;
  /** Flat length of the bend region (bend allowance). */
  allowance: number;
  /** Feature that made the bend. */
  feature: Id;
}

export interface FlatPattern {
  loops: FlatLoop[];
  bends: FlatBend[];
  thickness: number;
  /** Bounding box of the outline. */
  min: Vec2;
  max: Vec2;
  /** Things the flat pattern leaves out or cannot show exactly. */
  notes: string[];
  /** Where the flat pattern is shown in the model (flat x, y, thickness to world). */
  placement: Frame;
}

/** A bend note as drawings and the PropertyManager show it, e.g. "UP 90° R 1". */
export function bendNote(b: FlatBend, fmt: (mm: number) => string = (v) => trimNum(v)): string {
  return `${b.up ? 'UP' : 'DOWN'} ${trimNum(b.angle)}° R ${fmt(b.radius)}`;
}

export function trimNum(v: number, digits = 3): string {
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Overall size of the flat pattern (width along x, height along y). */
export const flatSize = (f: FlatPattern): Vec2 => [f.max[0] - f.min[0], f.max[1] - f.min[1]];

// ---- DXF ----

const deg = (r: number) => (r * 180) / Math.PI;
const num = (v: number) => {
  const s = (Math.abs(v) < 5e-10 ? 0 : v).toFixed(9);
  return s.replace(/\.?0+$/, '') || '0';
};

/**
 * The flat pattern as an ASCII DXF (AutoCAD R12, which every cutting
 * program reads): the outline on layer OUTLINE, holes and cuts on CUTS, bend
 * centre lines on BEND_UP or BEND_DOWN (dashed) and the bend notes on
 * BEND_NOTES.
 */
export function flatPatternDxf(f: FlatPattern, opts: { notes?: boolean } = {}): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => { out.push(String(code), typeof v === 'number' ? num(v) : v); };
  const layers: [string, number, string][] = [
    ['OUTLINE', 7, 'CONTINUOUS'], ['CUTS', 1, 'CONTINUOUS'], ['BEND_UP', 3, 'DASHED'], ['BEND_DOWN', 5, 'DASHED'], ['BEND_NOTES', 2, 'CONTINUOUS'],
  ];
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, f.min[0]); g(20, f.min[1]); g(30, 0);
  g(9, '$EXTMAX'); g(10, f.max[0]); g(20, f.max[1]); g(30, 0);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, 6); g(49, 4); g(49, -2);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [name, color, lt] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, lt); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const loop of f.loops) {
    const layer = loop.outer ? 'OUTLINE' : 'CUTS';
    for (const s of loop.segs) {
      if (s.k === 'line') { g(0, 'LINE'); g(8, layer); g(10, s.a[0]); g(20, s.a[1]); g(30, 0); g(11, s.b[0]); g(21, s.b[1]); g(31, 0); }
      else if (s.k === 'circle') { g(0, 'CIRCLE'); g(8, layer); g(10, s.c[0]); g(20, s.c[1]); g(30, 0); g(40, s.r); }
      else { g(0, 'ARC'); g(8, layer); g(10, s.c[0]); g(20, s.c[1]); g(30, 0); g(40, s.r); g(50, deg(s.a0)); g(51, deg(s.a1)); }
    }
  }
  for (const b of f.bends) {
    const layer = b.up ? 'BEND_UP' : 'BEND_DOWN';
    g(0, 'LINE'); g(8, layer); g(6, 'DASHED'); g(10, b.a[0]); g(20, b.a[1]); g(30, 0); g(11, b.b[0]); g(21, b.b[1]); g(31, 0);
    if (opts.notes !== false) {
      const h = Math.max(f.thickness, 1.5);
      const ang = deg(Math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0]));
      // Upright text along the line, beside its middle.
      const upright = ang > 90 || ang <= -90 ? ang + 180 : ang;
      const t = (upright * Math.PI) / 180;
      const m: Vec2 = [(b.a[0] + b.b[0]) / 2 - Math.sin(t) * h * 0.4, (b.a[1] + b.b[1]) / 2 + Math.cos(t) * h * 0.4];
      g(0, 'TEXT'); g(8, 'BEND_NOTES'); g(10, m[0]); g(20, m[1]); g(30, 0); g(40, h); g(1, bendNote(b).replace('°', '%%d')); g(50, upright); g(72, 1); g(11, m[0]); g(21, m[1]); g(31, 0);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/** Entities of a DXF file as code/value pairs per entity (for checks). */
export function parseDxfEntities(text: string): { type: string; layer: string; values: Map<number, string[]> }[] {
  const lines = text.split(/\r?\n/);
  const out: { type: string; layer: string; values: Map<number, string[]> }[] = [];
  let inEntities = false;
  let cur: { type: string; layer: string; values: Map<number, string[]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1].trim();
    if (!Number.isInteger(code)) throw new Error(`Bad group code at line ${i + 1}`);
    if (code === 2 && value === 'ENTITIES') { inEntities = true; continue; }
    if (code === 0) {
      if (cur) out.push(cur);
      cur = null;
      if (value === 'ENDSEC') { inEntities = false; continue; }
      if (inEntities) cur = { type: value, layer: '', values: new Map() };
      continue;
    }
    if (!cur) continue;
    if (code === 8) cur.layer = value;
    const list = cur.values.get(code);
    if (list) list.push(value); else cur.values.set(code, [value]);
  }
  return out;
}
