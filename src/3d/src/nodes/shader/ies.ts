// IES (LM-63) photometric files: parsing, sampling and resampling into a regular angle grid that
// the shader node compiler uploads as a 2D lookup texture.
//
// Angles follow type C photometry: the vertical angle is 0° straight down (-Z) and 180° straight
// up; the horizontal angle turns around Z. Values are interpolated with Catmull-Rom splines, the
// vertical axis mirrored across 0° and held at its last angle, the horizontal axis completed from
// the file's symmetry (single angle, quadrant, half or full circle).

export interface IesData {
  /** vertical angles in degrees, ascending */
  vertical: number[];
  /** horizontal angles in degrees, ascending */
  horizontal: number[];
  /** candela values [h][v], already multiplied by the file's multiplier and ballast factors */
  candela: number[][];
}

/** Scale from candela to the texture's output value (calibrated so files give the expected brightness). */
export const IES_SCALE = 0.0706651;

/** Parse an LM-63 file. Returns null when the text is not a usable photometric file. */
export function parseIes(text: string): IesData | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*TILT\s*=/i.test(lines[i])) i++;
  if (i >= lines.length) return null;
  const tilt = lines[i].split('=')[1]?.trim().toUpperCase() ?? 'NONE';
  const nums = lines
    .slice(i + 1)
    .join(' ')
    .split(/[\s,]+/)
    .filter((s) => s.length)
    .map(Number);
  let k = 0;
  const next = () => (k < nums.length ? nums[k++] : NaN);
  if (tilt === 'INCLUDE') {
    next(); // lamp-to-luminaire geometry
    const n = next();
    if (!(n >= 0)) return null;
    k += 2 * n; // tilt angles and multiplying factors
  }
  next(); // number of lamps
  next(); // lumens per lamp
  const multiplier = next();
  const nv = Math.round(next());
  const nh = Math.round(next());
  next(); // photometric type
  next(); // units type
  next();
  next();
  next(); // width, length, height
  const ballast = next();
  const ballastLamp = next();
  next(); // input watts
  if (!(nv > 0) || !(nh > 0) || !Number.isFinite(multiplier)) return null;
  const vertical: number[] = [];
  for (let j = 0; j < nv; j++) vertical.push(next());
  const horizontal: number[] = [];
  for (let j = 0; j < nh; j++) horizontal.push(next());
  const scale = multiplier * (Number.isFinite(ballast) ? ballast : 1) * (Number.isFinite(ballastLamp) && ballastLamp > 0 ? ballastLamp : 1);
  const candela: number[][] = [];
  for (let h = 0; h < nh; h++) {
    const row: number[] = [];
    for (let v = 0; v < nv; v++) row.push(next() * scale);
    candela.push(row);
  }
  if (candela.some((r) => r.some((x) => !Number.isFinite(x))) || vertical.some((x) => !Number.isFinite(x)) || horizontal.some((x) => !Number.isFinite(x))) return null;
  return { vertical, horizontal, candela };
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number) {
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

/** Spline through (xs, ys) at x; `pad(i)` supplies values outside 0..n-1, null = outside the data. */
function spline(xs: number[], ys: number[], x: number, pad: (i: number) => number): number {
  const n = xs.length;
  if (n === 1) return ys[0];
  let i = 0;
  while (i < n - 2 && x >= xs[i + 1]) i++;
  const span = xs[i + 1] - xs[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (x - xs[i]) / span)) : 0;
  const at = (j: number) => (j < 0 || j >= n ? pad(j) : ys[j]);
  return catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), t);
}

/** Candela-derived value along one horizontal row at vertical angle `v` (degrees). */
function verticalSample(d: IesData, row: number[], v: number): number {
  const vs = d.vertical;
  const first = vs[0],
    last = vs[vs.length - 1];
  if (v < first - 1e-6 || v > last + 1e-6) return 0;
  const n = vs.length;
  // mirrored across the downward pole, held at the far end
  const pad = (j: number) => (j < 0 ? (first <= 1e-6 ? row[Math.min(n - 1, -j)] : row[0]) : row[n - 1]);
  return Math.max(0, spline(vs, row, v, pad));
}

/** Map a horizontal angle (degrees, 0..360) into the angle range stored in the file. */
function foldHorizontal(d: IesData, h: number): number {
  const hs = d.horizontal;
  const last = hs[hs.length - 1];
  h = ((h % 360) + 360) % 360;
  if (hs.length === 1) return hs[0];
  if (Math.abs(last - 90) < 1e-3) {
    // quadrant symmetry
    h = h % 180;
    if (h > 90) h = 180 - h;
  } else if (Math.abs(last - 180) < 1e-3) {
    if (h > 180) h = 360 - h;
  }
  return h;
}

/** Interpolated value (before IES_SCALE) for a vertical and horizontal angle in degrees. */
export function sampleIes(d: IesData, vDeg: number, hDeg: number): number {
  const hs = d.horizontal;
  const h = foldHorizontal(d, hDeg);
  if (hs.length === 1) return verticalSample(d, d.candela[0], vDeg);
  const vals = d.candela.map((row) => verticalSample(d, row, vDeg));
  const n = hs.length;
  const full = hs[n - 1] - hs[0] >= 359.999;
  const pad = (j: number) => {
    if (full) {
      // the last angle repeats the first one (360° = 0°)
      const m = n - 1;
      return vals[(((j % m) + m) % m) as number];
    }
    // mirrored at both ends (symmetry planes)
    if (j < 0) return vals[Math.min(n - 1, -j)];
    return vals[Math.max(0, 2 * (n - 1) - j)];
  };
  return Math.max(0, spline(hs, vals, h, pad));
}

/** Resampled grid: rows = horizontal steps over 0..360°, columns = vertical steps over 0..180°, values scaled. */
export function iesGrid(d: IesData, vSteps = 64, hSteps = 64): { data: Float32Array; width: number; height: number } {
  const symmetric = d.horizontal.length === 1;
  const H = symmetric ? 1 : hSteps;
  const data = new Float32Array(vSteps * H * 4);
  for (let r = 0; r < H; r++) {
    const hDeg = H === 1 ? 0 : (r / (H - 1)) * 360;
    for (let c = 0; c < vSteps; c++) {
      const vDeg = (c / (vSteps - 1)) * 180;
      const val = sampleIes(d, vDeg, hDeg) * IES_SCALE;
      const k = (r * vSteps + c) * 4;
      data[k] = data[k + 1] = data[k + 2] = val;
      data[k + 3] = 1;
    }
  }
  return { data, width: vSteps, height: H };
}

/** Vertical and horizontal angles (degrees) of a direction for the lookup. */
export function iesAngles(x: number, y: number, z: number): [number, number] {
  const l = Math.hypot(x, y, z) || 1;
  const v = (Math.acos(Math.max(-1, Math.min(1, -z / l))) * 180) / Math.PI;
  let h = (Math.atan2(x, -y) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [v, h];
}
