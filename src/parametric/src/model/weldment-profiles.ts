// Weldment profile library: cross-sections of standard structural shapes,
// generated in code from their standard dimensions (no profile files are
// copied from any product). Lengths are millimetres; inch sizes are
// converted exactly (25.4 mm/in).
//
// Dimension sources:
// - ISO (metric) hollow sections: EN 10219-2 (cold formed welded structural
//   hollow sections). Square and rectangular tubes use the corner radii the
//   standard gives for calculating section properties: outside radius 2t,
//   inside radius t (t <= 6 mm); 2.5t / 1.5t (6 < t <= 10 mm); 3t / 2t above.
//   Pipes: outside diameters of EN 10220 / EN 10219-2.
// - ISO angles: EN 10056-1 (equal leg angles, root radius r1, toe radius r2).
// - ISO channels: EN 10279 parallel flange channels (UPE), root radius r.
// - ISO I-beams: EN 10365 (IPE and HE A), root radius r.
// - ISO flat bar: EN 10058; round bar: EN 10060.
// - ANSI (inch) HSS: ASTM A500 sizes, modelled with the nominal wall t and an
//   outside corner radius of 2t, inside radius t (the AISC Steel Construction
//   Manual's basis for HSS section properties).
// - ANSI pipe: ASME B36.10M standard weight (Sch 40) outside diameter and wall.
// - ANSI angles: ASTM A6 / AISC Manual leg and thickness sizes. A6 does not fix
//   the root and toe radii, so they are modelled with square corners.
// - ANSI channels: AISC Manual American Standard channels (C), depth d, flange
//   width bf, web tw and average flange thickness tf on the standard 1:6
//   (16 2/3 %) inner flange slope, without fillets.
// - ANSI W shapes: AISC Manual (d, bf, tw, tf, and the fillet radius k_des - tf).
// - ANSI flat and round bar: common ASTM A36 bar sizes.

export type WeldStandard = 'iso' | 'ansi';
export type WeldProfileType = 'squareTube' | 'rectTube' | 'pipe' | 'angle' | 'channel' | 'beam' | 'flatBar' | 'roundBar';

export const WELD_STANDARDS: { value: WeldStandard; label: string }[] = [
  { value: 'iso', label: 'ISO (metric)' },
  { value: 'ansi', label: 'ANSI (inch)' },
];

export const WELD_TYPES: { value: WeldProfileType; label: string }[] = [
  { value: 'squareTube', label: 'Square tube' },
  { value: 'rectTube', label: 'Rectangular tube' },
  { value: 'pipe', label: 'Pipe' },
  { value: 'angle', label: 'Angle' },
  { value: 'channel', label: 'Channel' },
  { value: 'beam', label: 'I/W-beam' },
  { value: 'flatBar', label: 'Flat bar' },
  { value: 'roundBar', label: 'Round bar' },
];

/** A piece of a profile outline: a line, or an arc from angle a0 to a1 (radians; a1 < a0 runs clockwise). */
export type PSeg =
  | { k: 'line'; a: [number, number]; b: [number, number] }
  | { k: 'arc'; c: [number, number]; r: number; a0: number; a1: number };

/** Outer loop counter-clockwise, holes clockwise. */
export interface ProfileShape {
  outer: PSeg[];
  holes: PSeg[][];
}

/** Dimensions of one size, in millimetres. */
export interface ProfileDims {
  /** Hollow sections: width B, height H, wall t. Pipe and round bar: D (and t). */
  B?: number; H?: number; t?: number; D?: number;
  /** Open sections: depth h, flange or leg width b, web tw, flange tf, root radius r, toe radius r2. */
  h?: number; b?: number; tw?: number; tf?: number; r?: number; r2?: number;
  /** Channels with sloped inner flange faces (the slope, as rise per run). */
  slope?: number;
  /** Outside and inside corner radius of a hollow section. */
  ro?: number; ri?: number;
}

export interface ProfileSize {
  /** Key stored in the part file. */
  id: string;
  /** Short size label (the combobox entry). */
  label: string;
  /** Cut list description, e.g. "SQ TUBE 40 x 40 x 3". */
  desc: string;
  dims: ProfileDims;
}

const IN = 25.4;

/** Corner radii of EN 10219-2 cold formed hollow sections. */
function en10219Radii(t: number): { ro: number; ri: number } {
  if (t <= 6) return { ro: 2 * t, ri: t };
  if (t <= 10) return { ro: 2.5 * t, ri: 1.5 * t };
  return { ro: 3 * t, ri: 2 * t };
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** Inch fractions as written on sizes: 0.25 -> "1/4", 1.5 -> "1-1/2". */
function frac(v: number): string {
  const whole = Math.floor(v + 1e-9);
  const rest = v - whole;
  if (rest < 1e-9) return String(whole);
  for (const d of [2, 4, 8, 16, 32]) {
    const k = Math.round(rest * d);
    if (Math.abs(rest * d - k) < 1e-6) {
      const g = gcd(k, d);
      const f = `${k / g}/${d / g}`;
      return whole ? `${whole}-${f}` : f;
    }
  }
  return n(v);
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

function isoSquare(B: number, t: number): ProfileSize {
  return { id: `${n(B)}x${n(B)}x${n(t)}`, label: `${n(B)} x ${n(B)} x ${n(t)}`, desc: `SQ TUBE ${n(B)} x ${n(B)} x ${n(t)}`, dims: { B, H: B, t, ...en10219Radii(t) } };
}

function isoRect(H: number, B: number, t: number): ProfileSize {
  return { id: `${n(H)}x${n(B)}x${n(t)}`, label: `${n(H)} x ${n(B)} x ${n(t)}`, desc: `RECT TUBE ${n(H)} x ${n(B)} x ${n(t)}`, dims: { B, H, t, ...en10219Radii(t) } };
}

function isoPipe(D: number, t: number): ProfileSize {
  return { id: `${n(D)}x${n(t)}`, label: `${n(D)} x ${n(t)}`, desc: `PIPE ${n(D)} x ${n(t)}`, dims: { D, t } };
}

function isoAngle(b: number, t: number, r1: number, r2: number): ProfileSize {
  return { id: `${n(b)}x${n(b)}x${n(t)}`, label: `${n(b)} x ${n(b)} x ${n(t)}`, desc: `L ${n(b)} x ${n(b)} x ${n(t)}`, dims: { h: b, b, t, r: r1, r2 } };
}

function upe(h: number, b: number, tw: number, tf: number, r: number): ProfileSize {
  return { id: `UPE${h}`, label: `UPE ${h}`, desc: `UPE ${h}`, dims: { h, b, tw, tf, r } };
}

function ibeam(name: string, h: number, b: number, tw: number, tf: number, r: number): ProfileSize {
  return { id: name.replace(/\s/g, ''), label: name, desc: name, dims: { h, b, tw, tf, r } };
}

function isoFlat(b: number, t: number): ProfileSize {
  return { id: `${n(b)}x${n(t)}`, label: `${n(b)} x ${n(t)}`, desc: `FLAT BAR ${n(b)} x ${n(t)}`, dims: { B: b, H: t } };
}

function isoRound(D: number): ProfileSize {
  return { id: `${n(D)}`, label: `Ø ${n(D)}`, desc: `ROUND BAR Ø ${n(D)}`, dims: { D } };
}

function hssSquare(B: number, t: number): ProfileSize {
  const s = `${frac(B)} x ${frac(B)} x ${frac(t)}`;
  return { id: s.replace(/ /g, ''), label: s, desc: `HSS ${s}`, dims: { B: B * IN, H: B * IN, t: t * IN, ro: 2 * t * IN, ri: t * IN } };
}

function hssRect(H: number, B: number, t: number): ProfileSize {
  const s = `${frac(H)} x ${frac(B)} x ${frac(t)}`;
  return { id: s.replace(/ /g, ''), label: s, desc: `HSS ${s}`, dims: { B: B * IN, H: H * IN, t: t * IN, ro: 2 * t * IN, ri: t * IN } };
}

function stdPipe(nps: string, D: number, t: number): ProfileSize {
  return { id: nps.replace(/ /g, ''), label: `${nps} STD (${n(D)} x ${n(t)} in)`, desc: `PIPE ${nps} STD`, dims: { D: D * IN, t: t * IN } };
}

function ansiAngle(a: number, b: number, t: number): ProfileSize {
  const s = `${frac(a)} x ${frac(b)} x ${frac(t)}`;
  return { id: s.replace(/ /g, ''), label: s, desc: `L ${s}`, dims: { h: a * IN, b: b * IN, t: t * IN, r: 0, r2: 0 } };
}

function cChannel(name: string, d: number, bf: number, tw: number, tf: number): ProfileSize {
  return { id: name.replace(/ /g, ''), label: name, desc: name, dims: { h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: 0, slope: 1 / 6 } };
}

function wShape(name: string, d: number, bf: number, tw: number, tf: number, kdes: number): ProfileSize {
  return { id: name.replace(/ /g, ''), label: name, desc: name, dims: { h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: (kdes - tf) * IN } };
}

function ansiFlat(b: number, t: number): ProfileSize {
  const s = `${frac(b)} x ${frac(t)}`;
  return { id: s.replace(/ /g, ''), label: s, desc: `FLAT BAR ${s}`, dims: { B: b * IN, H: t * IN } };
}

function ansiRound(D: number): ProfileSize {
  return { id: frac(D), label: `Ø ${frac(D)}`, desc: `ROUND BAR Ø ${frac(D)}`, dims: { D: D * IN } };
}

export const PROFILE_LIBRARY: Record<WeldStandard, Record<WeldProfileType, ProfileSize[]>> = {
  iso: {
    squareTube: [
      [20, 2], [25, 2], [30, 2], [30, 3], [40, 2], [40, 3], [40, 4], [50, 3], [50, 4], [50, 5], [60, 3], [60, 4], [60, 5],
      [80, 4], [80, 5], [80, 6], [100, 4], [100, 5], [100, 6], [100, 8], [120, 6], [150, 6], [150, 8],
    ].map(([B, t]) => isoSquare(B, t)),
    rectTube: [
      [40, 20, 2], [50, 30, 3], [60, 40, 3], [60, 40, 4], [80, 40, 3], [80, 40, 4], [100, 50, 4], [100, 50, 5], [100, 60, 4],
      [120, 60, 5], [120, 80, 5], [150, 100, 6], [200, 100, 6],
    ].map(([H, B, t]) => isoRect(H, B, t)),
    pipe: [
      [21.3, 2], [26.9, 2], [33.7, 2.6], [42.4, 2.6], [48.3, 3.2], [60.3, 3.2], [76.1, 3.2], [88.9, 3.2], [88.9, 4],
      [114.3, 3.6], [114.3, 5], [139.7, 5], [168.3, 5],
    ].map(([D, t]) => isoPipe(D, t)),
    angle: [
      [20, 3, 3.5, 2], [25, 3, 3.5, 2], [30, 3, 5, 2.5], [40, 4, 6, 3], [40, 5, 6, 3], [50, 5, 7, 3.5], [50, 6, 7, 3.5],
      [60, 6, 8, 4], [70, 7, 9, 4.5], [80, 8, 10, 5], [100, 10, 12, 6],
    ].map(([b, t, r1, r2]) => isoAngle(b, t, r1, r2)),
    channel: [
      upe(80, 50, 4, 7, 10), upe(100, 55, 4.5, 7.5, 10), upe(120, 60, 5, 8, 12), upe(140, 65, 5, 9, 12),
      upe(160, 70, 5.5, 9.5, 12), upe(180, 75, 5.5, 10.5, 12), upe(200, 80, 6, 11, 13),
    ],
    beam: [
      ibeam('IPE 80', 80, 46, 3.8, 5.2, 5), ibeam('IPE 100', 100, 55, 4.1, 5.7, 7), ibeam('IPE 120', 120, 64, 4.4, 6.3, 7),
      ibeam('IPE 140', 140, 73, 4.7, 6.9, 7), ibeam('IPE 160', 160, 82, 5, 7.4, 9), ibeam('IPE 180', 180, 91, 5.3, 8, 9),
      ibeam('IPE 200', 200, 100, 5.6, 8.5, 12), ibeam('IPE 240', 240, 120, 6.2, 9.8, 15), ibeam('IPE 300', 300, 150, 7.1, 10.7, 15),
      ibeam('HEA 100', 96, 100, 5, 8, 12), ibeam('HEA 120', 114, 120, 5, 8, 12), ibeam('HEA 140', 133, 140, 5.5, 8.5, 12),
      ibeam('HEA 160', 152, 160, 6, 9, 15), ibeam('HEA 200', 190, 200, 6.5, 10, 18),
    ],
    flatBar: [[20, 3], [20, 5], [25, 5], [30, 5], [40, 5], [40, 8], [50, 5], [50, 10], [60, 8], [80, 10], [100, 10]].map(([b, t]) => isoFlat(b, t)),
    roundBar: [6, 8, 10, 12, 16, 20, 25, 30, 40, 50].map(isoRound),
  },
  ansi: {
    squareTube: [
      [1.5, 1 / 8], [2, 1 / 8], [2, 3 / 16], [2, 1 / 4], [2.5, 3 / 16], [3, 3 / 16], [3, 1 / 4], [4, 1 / 4], [4, 3 / 8],
      [5, 1 / 4], [6, 1 / 4], [6, 3 / 8],
    ].map(([B, t]) => hssSquare(B, t)),
    rectTube: [
      [2, 1, 1 / 8], [3, 2, 3 / 16], [3, 2, 1 / 4], [4, 2, 1 / 4], [4, 3, 1 / 4], [6, 2, 1 / 4], [6, 3, 1 / 4], [6, 4, 1 / 4], [8, 4, 1 / 4],
    ].map(([H, B, t]) => hssRect(H, B, t)),
    pipe: [
      stdPipe('1/2', 0.84, 0.109), stdPipe('3/4', 1.05, 0.113), stdPipe('1', 1.315, 0.133), stdPipe('1-1/4', 1.66, 0.14),
      stdPipe('1-1/2', 1.9, 0.145), stdPipe('2', 2.375, 0.154), stdPipe('2-1/2', 2.875, 0.203), stdPipe('3', 3.5, 0.216),
      stdPipe('4', 4.5, 0.237), stdPipe('6', 6.625, 0.28),
    ],
    angle: [
      [1, 1, 1 / 8], [1.5, 1.5, 3 / 16], [2, 2, 1 / 4], [2.5, 2.5, 1 / 4], [3, 3, 1 / 4], [3, 3, 3 / 8], [4, 4, 3 / 8], [4, 4, 1 / 2],
      [3, 2, 1 / 4], [4, 3, 3 / 8],
    ].map(([a, b, t]) => ansiAngle(a, b, t)),
    channel: [
      cChannel('C 3 x 4.1', 3, 1.41, 0.17, 0.273), cChannel('C 4 x 5.4', 4, 1.58, 0.184, 0.296), cChannel('C 5 x 6.7', 5, 1.75, 0.19, 0.32),
      cChannel('C 6 x 8.2', 6, 1.92, 0.2, 0.343), cChannel('C 8 x 11.5', 8, 2.26, 0.22, 0.39), cChannel('C 10 x 15.3', 10, 2.6, 0.24, 0.436),
      cChannel('C 12 x 20.7', 12, 2.94, 0.282, 0.501),
    ],
    beam: [
      wShape('W 4 x 13', 4.16, 4.06, 0.28, 0.345, 0.595), wShape('W 6 x 9', 5.9, 3.94, 0.17, 0.215, 0.465),
      wShape('W 6 x 15', 5.99, 5.99, 0.23, 0.26, 0.51), wShape('W 8 x 10', 7.89, 3.94, 0.17, 0.205, 0.505),
      wShape('W 8 x 18', 8.14, 5.25, 0.23, 0.33, 0.63), wShape('W 10 x 12', 9.87, 3.96, 0.19, 0.21, 0.51),
      wShape('W 12 x 14', 11.9, 3.97, 0.2, 0.225, 0.525),
    ],
    flatBar: [[1, 1 / 8], [1, 1 / 4], [1.5, 1 / 4], [2, 1 / 4], [2, 3 / 8], [3, 1 / 4], [3, 3 / 8], [4, 1 / 2]].map(([b, t]) => ansiFlat(b, t)),
    roundBar: [0.25, 0.375, 0.5, 0.625, 0.75, 1, 1.25, 1.5, 2].map(ansiRound),
  },
};

export function profileSizes(standard: WeldStandard, type: WeldProfileType): ProfileSize[] {
  return PROFILE_LIBRARY[standard]?.[type] ?? [];
}

export function findProfile(standard: string, type: string, size: string): ProfileSize | null {
  const lib = (PROFILE_LIBRARY as Record<string, Record<string, ProfileSize[]> | undefined>)[standard];
  if (!lib || !Object.hasOwn(lib, type)) return null;
  return lib[type].find((s) => s.id === size) ?? null;
}

/** Whether a profile type is a closed hollow section (end caps go on these). */
export const isHollow = (type: string) => type === 'squareTube' || type === 'rectTube' || type === 'pipe';

// ---------- outline generation ----------

const line = (a: [number, number], b: [number, number]): PSeg => ({ k: 'line', a, b });
const arc = (c: [number, number], r: number, a0: number, a1: number): PSeg => ({ k: 'arc', c, r, a0, a1 });
const D90 = Math.PI / 2;

/** A loop through corner points, rounding the corners with the given radii (positive: convex, CCW loop). */
function roundedRect(w: number, h: number, r: number): PSeg[] {
  const x = w / 2, y = h / 2;
  if (r <= 1e-9) return [line([-x, -y], [x, -y]), line([x, -y], [x, y]), line([x, y], [-x, y]), line([-x, y], [-x, -y])];
  r = Math.min(r, x, y);
  const out: PSeg[] = [];
  const full = (a: [number, number], b: [number, number]) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) out.push(line(a, b)); };
  full([-x + r, -y], [x - r, -y]);
  out.push(arc([x - r, -y + r], r, -D90, 0));
  full([x, -y + r], [x, y - r]);
  out.push(arc([x - r, y - r], r, 0, D90));
  full([x - r, y], [-x + r, y]);
  out.push(arc([-x + r, y - r], r, D90, Math.PI));
  full([-x, y - r], [-x, -y + r]);
  out.push(arc([-x + r, -y + r], r, Math.PI, 3 * D90));
  return out;
}

export function reverseLoop(loop: PSeg[]): PSeg[] {
  return loop.slice().reverse().map((s) => (s.k === 'line' ? line(s.b, s.a) : arc(s.c, s.r, s.a1, s.a0)));
}

const circleLoop = (r: number): PSeg[] => [arc([0, 0], r, 0, 2 * Math.PI)];

/** Outer (and, for hollow sections, inner) outline of a profile, in its own coordinates. */
export function profileShape(type: WeldProfileType | string, d: ProfileDims): ProfileShape {
  switch (type) {
    case 'squareTube':
    case 'rectTube': {
      const { B = 0, H = 0, t = 0, ro = 0, ri = 0 } = d;
      return { outer: roundedRect(B, H, ro), holes: [reverseLoop(roundedRect(B - 2 * t, H - 2 * t, ri))] };
    }
    case 'pipe': {
      const { D = 0, t = 0 } = d;
      return { outer: circleLoop(D / 2), holes: [reverseLoop(circleLoop(D / 2 - t))] };
    }
    case 'roundBar':
      return { outer: circleLoop((d.D ?? 0) / 2), holes: [] };
    case 'flatBar':
      return { outer: roundedRect(d.B ?? 0, d.H ?? 0, 0), holes: [] };
    case 'angle': {
      // Heel at the origin, legs along +x (width b) and +y (height h).
      const { h = 0, b = 0, t = 0, r = 0, r2 = 0 } = d;
      const o: PSeg[] = [line([0, 0], [b, 0])];
      if (r2 > 0) o.push(line([b, 0], [b, t - r2]), arc([b - r2, t - r2], r2, 0, D90));
      else o.push(line([b, 0], [b, t]));
      o.push(line([r2 > 0 ? b - r2 : b, t], [t + r, t]));
      if (r > 0) o.push(arc([t + r, t + r], r, 3 * D90, Math.PI));
      o.push(line([t, t + r], [t, r2 > 0 ? h - r2 : h]));
      if (r2 > 0) o.push(arc([t - r2, h - r2], r2, 0, D90));
      o.push(line([r2 > 0 ? t - r2 : t, h], [0, h]), line([0, h], [0, 0]));
      return { outer: o, holes: [] };
    }
    case 'channel': {
      // Web along the y axis at x 0..tw, flanges toward +x; depth h centred on y = 0.
      const { h = 0, b = 0, tw = 0, tf = 0, r = 0, slope = 0 } = d;
      const y = h / 2;
      if (slope > 0) {
        // Flange thickness tf is at the middle of the flange's inner face.
        const run = (b - tw) / 2;
        const toe = tf - run * slope, root = tf + run * slope;
        const pts: [number, number][] = [[0, -y], [b, -y], [b, -y + toe], [tw, -y + root], [tw, y - root], [b, y - toe], [b, y], [0, y]];
        return { outer: pts.map((p, i) => line(p, pts[(i + 1) % pts.length])), holes: [] };
      }
      const o: PSeg[] = [line([0, -y], [b, -y]), line([b, -y], [b, -y + tf]), line([b, -y + tf], [tw + r, -y + tf])];
      if (r > 0) o.push(arc([tw + r, -y + tf + r], r, 3 * D90, Math.PI));
      o.push(line([tw, -y + tf + r], [tw, y - tf - r]));
      if (r > 0) o.push(arc([tw + r, y - tf - r], r, Math.PI, D90));
      o.push(line([tw + r, y - tf], [b, y - tf]), line([b, y - tf], [b, y]), line([b, y], [0, y]), line([0, y], [0, -y]));
      return { outer: o, holes: [] };
    }
    case 'beam': {
      // Symmetric I section centred on the origin.
      const { h = 0, b = 0, tw = 0, tf = 0, r = 0 } = d;
      const x = b / 2, y = h / 2, w = tw / 2;
      const o: PSeg[] = [line([-x, -y], [x, -y]), line([x, -y], [x, -y + tf]), line([x, -y + tf], [w + r, -y + tf])];
      if (r > 0) o.push(arc([w + r, -y + tf + r], r, 3 * D90, Math.PI));
      o.push(line([w, -y + tf + r], [w, y - tf - r]));
      if (r > 0) o.push(arc([w + r, y - tf - r], r, Math.PI, D90));
      o.push(line([w + r, y - tf], [x, y - tf]), line([x, y - tf], [x, y]), line([x, y], [-x, y]), line([-x, y], [-x, y - tf]), line([-x, y - tf], [-w - r, y - tf]));
      if (r > 0) o.push(arc([-w - r, y - tf - r], r, D90, 0));
      o.push(line([-w, y - tf - r], [-w, -y + tf + r]));
      if (r > 0) o.push(arc([-w - r, -y + tf + r], r, 0, -D90));
      o.push(line([-w - r, -y + tf], [-x, -y + tf]), line([-x, -y + tf], [-x, -y]));
      return { outer: o, holes: [] };
    }
    default:
      return { outer: [], holes: [] };
  }
}

// ---------- section properties ----------

/** Contributions of one segment to the area and first moments (Green's theorem). */
function segMoments(s: PSeg): { a: number; mx: number; my: number } {
  if (s.k === 'line') {
    const [x0, y0] = s.a, [x1, y1] = s.b;
    // The same integrands as the arcs below (the usual polygon formula uses
    // another form, which only agrees for whole polygons).
    return { a: (x0 * y1 - x1 * y0) / 2, mx: ((y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1)) / 6, my: (-(x1 - x0) * (y0 * y0 + y0 * y1 + y1 * y1)) / 6 };
  }
  const { c: [cx, cy], r, a0, a1 } = s;
  const s0 = Math.sin(a0), s1 = Math.sin(a1), c0 = Math.cos(a0), c1 = Math.cos(a1);
  // A = 1/2 ∮ x dy - y dx
  const a = (r * r * (a1 - a0) + r * (cx * (s1 - s0) - cy * (c1 - c0))) / 2;
  // ∬ x dA = 1/2 ∮ x² dy, with x = cx + r cos θ, dy = r cos θ dθ.
  const ic = s1 - s0;
  const ic2 = (a1 - a0) / 2 + (s1 * c1 - s0 * c0) / 2;
  const ic3 = (s1 - s1 ** 3 / 3) - (s0 - s0 ** 3 / 3);
  const mx = (cx * cx * r * ic + 2 * cx * r * r * ic2 + r ** 3 * ic3) / 2;
  // ∬ y dA = -1/2 ∮ y² dx, with y = cy + r sin θ, dx = -r sin θ dθ.
  const is = -(c1 - c0);
  const is2 = (a1 - a0) / 2 - (s1 * c1 - s0 * c0) / 2;
  const is3 = (-c1 + c1 ** 3 / 3) - (-c0 + c0 ** 3 / 3);
  const my = (cy * cy * r * is + 2 * cy * r * r * is2 + r ** 3 * is3) / 2;
  return { a, mx, my };
}

/** Area and centroid of a profile (holes subtract). */
export function sectionProps(shape: ProfileShape): { area: number; centroid: [number, number] } {
  let a = 0, mx = 0, my = 0;
  for (const loop of [shape.outer, ...shape.holes]) {
    for (const s of loop) {
      const m = segMoments(s);
      a += m.a; mx += m.mx; my += m.my;
    }
  }
  return { area: a, centroid: a ? [mx / a, my / a] : [0, 0] };
}

/** Largest value of g·p over the outline (exact: line ends and arc extremes). */
export function outlineMax(loop: PSeg[], g: [number, number]): number {
  let best = -Infinity;
  for (const s of loop) {
    if (s.k === 'line') {
      best = Math.max(best, g[0] * s.a[0] + g[1] * s.a[1], g[0] * s.b[0] + g[1] * s.b[1]);
      continue;
    }
    const { c, r, a0, a1 } = s;
    const at = (t: number) => g[0] * (c[0] + r * Math.cos(t)) + g[1] * (c[1] + r * Math.sin(t));
    best = Math.max(best, at(a0), at(a1));
    const gl = Math.hypot(g[0], g[1]);
    if (gl > 0) {
      // The arc's point facing g, if the arc passes it.
      const th = Math.atan2(g[1], g[0]);
      const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
      const k = Math.ceil((lo - th) / (2 * Math.PI));
      if (th + k * 2 * Math.PI <= hi + 1e-12) best = Math.max(best, g[0] * c[0] + g[1] * c[1] + r * gl);
    }
  }
  return best;
}

/** Points along the outline (line ends and arcs every few degrees). */
export function outlinePoints(loop: PSeg[], stepDeg = 3): [number, number][] {
  const out: [number, number][] = [];
  for (const s of loop) {
    if (s.k === 'line') { out.push(s.a, s.b); continue; }
    const k = Math.max(2, Math.ceil(Math.abs(s.a1 - s.a0) / ((stepDeg * Math.PI) / 180)));
    for (let i = 0; i <= k; i++) {
      const t = s.a0 + ((s.a1 - s.a0) * i) / k;
      out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
    }
  }
  return out;
}

/** Bounding box of an outline. */
export function outlineBox(loop: PSeg[]): { min: [number, number]; max: [number, number] } {
  return {
    min: [-outlineMax(loop, [-1, 0]), -outlineMax(loop, [0, -1])],
    max: [outlineMax(loop, [1, 0]), outlineMax(loop, [0, 1])],
  };
}

// ---------- placement ----------

export type PiercePoint = 'centroid' | 'center' | 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';

export const PIERCE_POINTS: { value: PiercePoint; label: string }[] = [
  { value: 'centroid', label: 'Centroid' },
  { value: 'center', label: 'Center of bounding box' },
  { value: 'tl', label: 'Top left corner' },
  { value: 'tc', label: 'Top edge center' },
  { value: 'tr', label: 'Top right corner' },
  { value: 'ml', label: 'Left edge center' },
  { value: 'mr', label: 'Right edge center' },
  { value: 'bl', label: 'Bottom left corner' },
  { value: 'bc', label: 'Bottom edge center' },
  { value: 'br', label: 'Bottom right corner' },
];

export interface Placement {
  pierce: PiercePoint;
  /** Degrees, counter-clockwise looking along the member. */
  rotation: number;
  mirror: boolean;
}

/** Where a pierce point is on a profile (in the profile's own coordinates). */
export function piercePointOf(shape: ProfileShape, p: PiercePoint): [number, number] {
  if (p === 'centroid') return sectionProps(shape).centroid;
  const { min, max } = outlineBox(shape.outer);
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const x = p[1] === 'l' ? min[0] : p[1] === 'r' ? max[0] : cx;
  const y = p[0] === 't' ? max[1] : p[0] === 'b' ? min[1] : cy;
  return p === 'center' ? [cx, cy] : [x, y];
}

/**
 * The profile moved so its pierce point is at the origin (where the sketch
 * segment runs), mirrored about its vertical axis and turned. Loops keep
 * their orientation (outer counter-clockwise).
 */
export function placeProfile(shape: ProfileShape, pl: Placement): ProfileShape {
  return placeWith(shape, piercePointOf(shape, pl.pierce), pl);
}

/** Like placeProfile, with the pierce point given (an end cap is placed by its member's profile). */
export function placeWith(shape: ProfileShape, [px, py]: [number, number], pl: Placement): ProfileShape {
  const a = (pl.rotation * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const m = pl.mirror ? -1 : 1;
  const tp = (p: [number, number]): [number, number] => {
    const x = (p[0] - px) * m, y = p[1] - py;
    return [x * ca - y * sa, x * sa + y * ca];
  };
  const ta = (t: number) => (pl.mirror ? Math.PI - t : t) + a;
  const map = (loop: PSeg[]): PSeg[] => {
    const out = loop.map((s): PSeg => (s.k === 'line' ? line(tp(s.a), tp(s.b)) : arc(tp(s.c), s.r, ta(s.a0), ta(s.a1))));
    // A mirror reverses the direction the loop runs.
    return pl.mirror ? reverseLoop(out) : out;
  };
  return { outer: map(shape.outer), holes: shape.holes.map(map) };
}
