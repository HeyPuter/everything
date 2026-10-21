// Fluid domain display data: the coarse fields shown by the slice, grid display and vector display
// options, and the pure helpers that turn them into slice values and vector line segments.
import type { Vector3 } from 'three';
import type { FluidDomainSettings } from './fluid';

/** Coarse grid data a domain shows with its display options. */
export interface FluidOverlay {
  objectId: string;
  nx: number;
  ny: number;
  nz: number;
  bmin: [number, number, number];
  bmax: [number, number, number];
  liquid: boolean;
  /** RG8 density / flame (gas) */
  density?: Uint8Array;
  /** heat (u8, 0..4) */
  heat?: Uint8Array;
  /** velocity (i8 xyz, scaled by velScale / 127), grid cells per second */
  vel?: Int8Array;
  velScale?: number;
  /** guide velocities (xyz + weight per cell) and force field accelerations (xyz per cell) */
  guide?: Float32Array | null;
  force?: Float32Array | null;
  /** liquid: particles per cell (level set stand-in) */
  phi?: Float32Array;
  settings: FluidDomainSettings;
  /** smoke color (gas) */
  color: [number, number, number];
}

/** Overlays per `${object id}:${modifier id}` (viewport evaluation only). */
export const fluidOverlays = new Map<string, FluidOverlay>();

/** Whether the overlay replaces the default smoke volume (slice or color ramp view). */
export const replacesVolume = (s: FluidDomainSettings | undefined) => !!s && (!!s.use_slice || !!s.use_color_ramp);

// ---------------------------------------------------------------------------
// Field values

/** Scalar field (one value per coarse cell) shown by the slice / grid display. */
export function scalarField(o: FluidOverlay, field: string): Float32Array {
  const n = o.nx * o.ny * o.nz;
  const out = new Float32Array(n);
  const vs = (o.velScale ?? 0) / 127;
  for (let c = 0; c < n; c++) {
    let v = 0;
    switch (field) {
      case 'DENSITY':
        v = (o.density?.[c * 2] ?? 0) / 255;
        break;
      case 'FLAME':
        v = (o.density?.[c * 2 + 1] ?? 0) / 255;
        break;
      case 'HEAT':
        v = ((o.heat?.[c] ?? 0) / 255) * 4;
        break;
      case 'VELOCITY_X':
        v = (o.vel?.[c * 3] ?? 0) * vs;
        break;
      case 'VELOCITY_Y':
        v = (o.vel?.[c * 3 + 1] ?? 0) * vs;
        break;
      case 'VELOCITY_Z':
        v = (o.vel?.[c * 3 + 2] ?? 0) * vs;
        break;
      case 'PHI':
        v = o.phi?.[c] ?? 0;
        break;
    }
    out[c] = v;
  }
  return out;
}

/** Vectors (xyz per cell, grid units per second) for the vector display. */
export function vectorField(o: FluidOverlay, field: string): Float32Array | null {
  const n = o.nx * o.ny * o.nz;
  if (field === 'FORCE') return o.force ?? null;
  if (field === 'GUIDE_VELOCITY') {
    if (!o.guide) return null;
    const out = new Float32Array(n * 3);
    for (let c = 0; c < n; c++) for (let a = 0; a < 3; a++) out[c * 3 + a] = o.guide[c * 4 + a] * (o.guide[c * 4 + 3] > 0 ? 1 : 0);
    return out;
  }
  if (!o.vel) return null;
  const vs = (o.velScale ?? 0) / 127;
  const out = new Float32Array(n * 3);
  for (let c = 0; c < n * 3; c++) out[c] = o.vel[c] * vs;
  return out;
}

/** The slice axis (0 x, 1 y, 2 z): fixed, or the local axis closest to the view direction. */
export function sliceAxis(s: FluidDomainSettings, viewDirLocal: Vector3 | null): number {
  const a = s.slice_axis ?? 'AUTO';
  if (a === 'X') return 0;
  if (a === 'Y') return 1;
  if (a === 'Z') return 2;
  if (!viewDirLocal) return 2;
  const ax = Math.abs(viewDirLocal.x),
    ay = Math.abs(viewDirLocal.y),
    az = Math.abs(viewDirLocal.z);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}

/**
 * Line segments of the vector display (domain-local coordinates, plus a color per vertex).
 * Only cells on the slice are used when slicing; otherwise cells are thinned to stay below `max`.
 */
export function vectorLines(o: FluidOverlay, axis: number | null, depth: number, max = 24000): { pos: Float32Array; col: Float32Array } {
  const s = o.settings;
  const V = vectorField(o, s.vector_field ?? 'FLUID_VELOCITY');
  const { nx, ny, nz } = o;
  if (!V) return { pos: new Float32Array(0), col: new Float32Array(0) };
  const cs = [(o.bmax[0] - o.bmin[0]) / nx, (o.bmax[1] - o.bmin[1]) / ny, (o.bmax[2] - o.bmin[2]) / nz];
  const dims = [nx, ny, nz];
  let vmax = 1e-6;
  for (let c = 0; c < V.length; c += 3) vmax = Math.max(vmax, Math.hypot(V[c], V[c + 1], V[c + 2]));
  const sliceIdx = axis === null ? -1 : Math.min(dims[axis] - 1, Math.max(0, Math.floor(depth * dims[axis])));
  const cells: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (axis !== null && [i, j, k][axis] !== sliceIdx) continue;
        const c = i + j * nx + k * nx * ny;
        if (Math.hypot(V[c * 3], V[c * 3 + 1], V[c * 3 + 2]) < vmax * 1e-3) continue;
        cells.push(c);
      }
  const stride = Math.max(1, Math.ceil(cells.length / max));
  const type = s.vector_display_type ?? 'NEEDLE';
  const scale = s.vector_scale ?? 1;
  const mag = !!s.vector_scale_with_magnitude;
  const pos: number[] = [],
    col: number[] = [];
  const color = (t: number) => [Math.min(1, 0.2 + 1.6 * t), Math.min(1, 1.6 * t * (1 - t) + 0.3), Math.max(0, 1 - 1.4 * t)];
  const cellLen = Math.min(...cs);
  const sampleV = (x: number, y: number, z: number, out: number[]) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(x))),
      j = Math.min(ny - 1, Math.max(0, Math.floor(y))),
      k = Math.min(nz - 1, Math.max(0, Math.floor(z)));
    const c = (i + j * nx + k * nx * ny) * 3;
    out[0] = V[c];
    out[1] = V[c + 1];
    out[2] = V[c + 2];
  };
  const tmp = [0, 0, 0];
  for (let q = 0; q < cells.length; q += stride) {
    const c = cells[q];
    const i = c % nx,
      j = Math.floor(c / nx) % ny,
      k = Math.floor(c / (nx * ny));
    const vx = V[c * 3],
      vy = V[c * 3 + 1],
      vz = V[c * 3 + 2];
    const m = Math.hypot(vx, vy, vz);
    const t = m / vmax;
    const rgb = color(t);
    const px = o.bmin[0] + (i + 0.5) * cs[0],
      py = o.bmin[1] + (j + 0.5) * cs[1],
      pz = o.bmin[2] + (k + 0.5) * cs[2];
    if (type === 'MAC') {
      const comps: [boolean, number, number][] = [
        [s.vector_show_mac_x !== false, 0, vx],
        [s.vector_show_mac_y !== false, 1, vy],
        [s.vector_show_mac_z !== false, 2, vz],
      ];
      for (const [on, a, v] of comps) {
        if (!on || v === 0) continue;
        const len = (mag ? v / vmax : Math.sign(v)) * cellLen * 0.5 * scale;
        const p0 = [px, py, pz];
        // MAC components sit on the lower face of the cell along their axis
        p0[a] -= cs[a] * 0.5;
        const p1 = p0.slice();
        p1[a] += len;
        pos.push(...p0, ...p1);
        const cc = a === 0 ? [1, 0.25, 0.25] : a === 1 ? [0.3, 1, 0.3] : [0.35, 0.5, 1];
        col.push(...cc, ...cc);
      }
      continue;
    }
    if (type === 'STREAMLINE') {
      // a few integration steps through the (cell-constant) field
      let x = i + 0.5,
        y = j + 0.5,
        z = k + 0.5;
      const steps = 6;
      const h = (scale * 0.5) / Math.max(1e-6, vmax);
      for (let st = 0; st < steps; st++) {
        sampleV(x, y, z, tmp);
        const nxp = x + tmp[0] * h,
          nyp = y + tmp[1] * h,
          nzp = z + tmp[2] * h;
        pos.push(o.bmin[0] + x * cs[0], o.bmin[1] + y * cs[1], o.bmin[2] + z * cs[2], o.bmin[0] + nxp * cs[0], o.bmin[1] + nyp * cs[1], o.bmin[2] + nzp * cs[2]);
        col.push(...rgb, ...rgb);
        x = nxp;
        y = nyp;
        z = nzp;
        if (x < 0 || y < 0 || z < 0 || x > nx || y > ny || z > nz) break;
      }
      continue;
    }
    // needle: a line along the vector (unit length per cell unless scaled by the magnitude)
    const len = (mag ? t : 1) * cellLen * 0.9 * scale;
    const dx = (vx / m) * len,
      dy = (vy / m) * len,
      dz = (vz / m) * len;
    pos.push(px - dx * 0.5, py - dy * 0.5, pz - dz * 0.5, px + dx * 0.5, py + dy * 0.5, pz + dz * 0.5);
    col.push(rgb[0] * 0.4, rgb[1] * 0.4, rgb[2] * 0.4, ...rgb);
  }
  return { pos: new Float32Array(pos), col: new Float32Array(col) };
}

