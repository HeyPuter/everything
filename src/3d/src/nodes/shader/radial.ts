// Radial Tiling: splits the plane around the origin into `sides` wedge segments and returns
// coordinates local to each segment (x across the segment, y outward), the segment index, its
// half width and its centre angle. Roundness morphs the polygonal segment edges into a circle.
// The TypeScript version mirrors the GLSL chunk below (kept line by line in sync).

export interface RadialTile {
  /** local coordinates (z is always 0) */
  co: [number, number, number];
  id: number;
  width: number;
  rotation: number;
}

const TAU = Math.PI * 2;

/** Distance from the origin to a polygon edge with corners rounded by `rho` (apothem 1), along local angle `d` (|d| ≤ h). */
function roundedRadius(d: number, h: number, rho: number): number {
  const tx = (1 - rho) * Math.tan(h);
  const ta = Math.atan(tx);
  if (d <= ta) return 1 / Math.cos(d);
  const cx = tx,
    cy = 1 - rho;
  const ux = Math.sin(d),
    uy = Math.cos(d);
  const b = ux * cx + uy * cy;
  const cc = cx * cx + cy * cy - rho * rho;
  return b + Math.sqrt(Math.max(b * b - cc, 0));
}

export function radialTiling(px: number, py: number, sides: number, roundness: number, normalize: boolean): RadialTile {
  const n = Math.max(2, sides);
  const rho = Math.min(1, Math.max(0, roundness));
  let a = Math.atan2(py, px);
  if (a < 0) a += TAU;
  const seg = TAU / n;
  const k = Math.min(Math.floor(a / seg), Math.ceil(n) - 1);
  const start = k * seg;
  const end = Math.min(start + seg, TAU);
  const h = (end - start) / 2;
  const rot = start + h;
  // segments narrower than the regular ones (the last one for fractional counts) share the
  // regular segments' corner radius
  const cosFull = Math.cos(Math.PI / n);
  const scale = cosFull > 1e-6 ? Math.cos(h) / cosFull : 1;
  const sr = Math.sin(rot),
    cr = Math.cos(rot);
  const lx = (-px * sr + py * cr) / scale;
  const ly = (px * cr + py * sr) / scale;
  const d = Math.atan2(Math.abs(lx), ly);
  const r = Math.hypot(lx, ly);
  const tanH = n <= 2 ? 0 : Math.tan(h);
  // depth: scale of the (rounded) polygon passing through the point
  let v: number;
  let x: number;
  let xEdge: number;
  if (rho <= 0 || n <= 2) {
    v = ly;
    x = lx;
    xEdge = v * tanH;
  } else {
    v = r / roundedRadius(Math.min(d, h), h, rho);
    // across-segment coordinate: exact on the straight part of the edge, blended towards the
    // angular coordinate on the rounded corner
    const ta = Math.atan((1 - rho) * Math.tan(h));
    const corner = (1 - rho) * (1 + 0.5 * rho) * Math.tan(h) * v + rho * h - rho * (1 - rho) * (Math.tan(h) - 0.5 * h);
    const straight = v * (1 - rho) * Math.tan(h);
    xEdge = rho >= 1 ? h : corner;
    let ax: number;
    if (rho >= 1) ax = d;
    else if (d <= ta) ax = v * Math.tan(d);
    else ax = straight + (corner - straight) * ((d - ta) / Math.max(h - ta, 1e-9));
    x = Math.sign(lx) * ax;
  }
  const width = n <= 2 ? 0 : rho <= 0 ? tanH : h + (tanH - h) * Math.pow(1 - rho, 2.5);
  const co: [number, number, number] = normalize ? [xEdge > 0 ? 0.5 + (0.5 * x) / xEdge : 0.5, v, 0] : [x, v - 1, 0];
  return { co, id: k, width, rotation: rot };
}

export const RADIAL_GLSL = `
float nd_rt_rounded(float d, float h, float rho) {
  float tx = (1.0 - rho) * tan(h);
  float ta = atan(tx);
  if (d <= ta) return 1.0 / cos(d);
  float cx = tx, cy = 1.0 - rho;
  float b = sin(d) * cx + cos(d) * cy;
  float cc = cx * cx + cy * cy - rho * rho;
  return b + sqrt(max(b * b - cc, 0.0));
}
// returns co.xy, id, width, rotation through out params
void nd_radial_tiling(vec3 p, float sides, float roundness, bool norm, out vec3 co, out float id, out float width, out float rot) {
  const float TAU = 6.283185307179586;
  float n = max(2.0, sides);
  float rho = clamp(roundness, 0.0, 1.0);
  float a = atan(p.y, p.x);
  if (a < 0.0) a += TAU;
  float seg = TAU / n;
  float k = min(floor(a / seg), ceil(n) - 1.0);
  float start = k * seg;
  float end = min(start + seg, TAU);
  float h = (end - start) * 0.5;
  rot = start + h;
  float cosFull = cos(3.141592653589793 / n);
  float scale = cosFull > 1e-6 ? cos(h) / cosFull : 1.0;
  float sr = sin(rot), cr = cos(rot);
  float lx = (-p.x * sr + p.y * cr) / scale;
  float ly = (p.x * cr + p.y * sr) / scale;
  float d = atan(abs(lx), ly);
  float r = length(vec2(lx, ly));
  float tanH = n <= 2.0 ? 0.0 : tan(h);
  float v, x, xEdge;
  if (rho <= 0.0 || n <= 2.0) {
    v = ly; x = lx; xEdge = v * tanH;
  } else {
    v = r / nd_rt_rounded(min(d, h), h, rho);
    float ta = atan((1.0 - rho) * tan(h));
    float corner = (1.0 - rho) * (1.0 + 0.5 * rho) * tan(h) * v + rho * h - rho * (1.0 - rho) * (tan(h) - 0.5 * h);
    float straight = v * (1.0 - rho) * tan(h);
    xEdge = rho >= 1.0 ? h : corner;
    float ax;
    if (rho >= 1.0) ax = d;
    else if (d <= ta) ax = v * tan(d);
    else ax = straight + (corner - straight) * ((d - ta) / max(h - ta, 1e-9));
    x = sign(lx) * ax;
  }
  width = n <= 2.0 ? 0.0 : (rho <= 0.0 ? tanH : h + (tanH - h) * pow(1.0 - rho, 2.5));
  co = norm ? vec3(xEdge > 0.0 ? 0.5 + 0.5 * x / xEdge : 0.5, v, 0.0) : vec3(x, v - 1.0, 0.0);
  id = k;
}
`;
