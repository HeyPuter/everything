/**
 * .cube color lookup tables (the common text format): 1D and 3D tables with
 * optional title and input domain. parseCube() validates untrusted text;
 * lutVolume() turns either kind into the RGBA float volume the compositor
 * uploads as a 3D texture.
 */

export const MAX_LUT_SIZE_3D = 65;
export const MAX_LUT_SIZE_1D = 65536;
/** 1D tables are resampled into a 3D volume of this size. */
export const VOLUME_FOR_1D = 33;

export class CubeError extends Error {}

/**
 * Parse .cube text. Returns
 *   { kind: '1d' | '3d', size, title, domainMin: [r,g,b], domainMax: [r,g,b], data: Float32Array }
 * where data holds size (1D) or size^3 (3D) RGB triples, red changing
 * fastest. Throws CubeError with a readable message on bad input.
 */
export function parseCube(text) {
  if (typeof text !== 'string') throw new CubeError('Not a text file');
  if (text.length > 64 * 1024 * 1024) throw new CubeError('This LUT file is too large');
  let title = '';
  let size1 = 0;
  let size3 = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let data = null;
  let n = 0;
  let expected = 0;
  const lines = text.split(/\r\n|\n|\r/);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // A quoted title may hold a #; the rest of the line can still be a comment.
    const quoted = /^\s*TITLE\s+"([^"]*)"/i.exec(line);
    if (quoted) {
      title = quoted[1].slice(0, 120);
      continue;
    }
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const c = line.charCodeAt(0);
    // Data rows start with a digit, sign or dot.
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      if (!data) {
        const size = size3 || size1;
        if (!size) throw new CubeError('The LUT size is missing (LUT_3D_SIZE or LUT_1D_SIZE)');
        expected = size3 ? size3 ** 3 : size1;
        data = new Float32Array(expected * 3);
      }
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new CubeError(`Line ${li + 1}: expected three numbers`);
      if (n >= expected) throw new CubeError('The LUT has more entries than its size says');
      for (let k = 0; k < 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v)) throw new CubeError(`Line ${li + 1}: "${parts[k]}" is not a number`);
        data[n * 3 + k] = v;
      }
      n++;
      continue;
    }
    const sp = line.search(/\s/);
    const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp).trim();
    if (data && key !== 'TITLE') throw new CubeError(`Line ${li + 1}: "${key}" after the table data`);
    switch (key) {
      case 'TITLE':
        title = rest.replace(/^"|"$/g, '').slice(0, 120);
        break;
      case 'LUT_3D_SIZE': {
        const s = Number(rest);
        if (!Number.isInteger(s) || s < 2 || s > MAX_LUT_SIZE_3D) throw new CubeError(`3D LUT size must be 2 to ${MAX_LUT_SIZE_3D}`);
        size3 = s;
        break;
      }
      case 'LUT_1D_SIZE': {
        const s = Number(rest);
        if (!Number.isInteger(s) || s < 2 || s > MAX_LUT_SIZE_1D) throw new CubeError(`1D LUT size must be 2 to ${MAX_LUT_SIZE_1D}`);
        size1 = s;
        break;
      }
      case 'DOMAIN_MIN':
      case 'DOMAIN_MAX': {
        const v = rest.split(/\s+/).map(Number);
        if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) throw new CubeError(`Line ${li + 1}: ${key} needs three numbers`);
        if (key === 'DOMAIN_MIN') domainMin = v.slice(0, 3);
        else domainMax = v.slice(0, 3);
        break;
      }
      case 'LUT_1D_INPUT_RANGE':
      case 'LUT_3D_INPUT_RANGE': {
        const v = rest.split(/\s+/).map(Number);
        if (v.length < 2 || !v.slice(0, 2).every(Number.isFinite)) throw new CubeError(`Line ${li + 1}: ${key} needs two numbers`);
        domainMin = [v[0], v[0], v[0]];
        domainMax = [v[1], v[1], v[1]];
        break;
      }
      default:
        // Unknown keywords (vendor extensions) are ignored.
        break;
    }
  }
  if (size1 && size3) throw new CubeError('The file declares both a 1D and a 3D size');
  if (!data || n === 0) throw new CubeError('The LUT has no table data');
  if (n !== expected) throw new CubeError(`The LUT has ${n} entries but its size needs ${expected}`);
  for (let k = 0; k < 3; k++) if (!(domainMax[k] > domainMin[k])) throw new CubeError('DOMAIN_MAX must be larger than DOMAIN_MIN');
  return { kind: size3 ? '3d' : '1d', size: size3 || size1, title, domainMin, domainMax, data };
}

/** Linear lookup into one channel of a 1D table at normalized position t in 0..1. */
function sample1D(data, size, ch, t) {
  const x = Math.min(1, Math.max(0, t)) * (size - 1);
  const i = Math.min(size - 2, Math.floor(x));
  const f = x - i;
  return data[i * 3 + ch] * (1 - f) + data[(i + 1) * 3 + ch] * f;
}

/**
 * RGBA float volume for a 3D texture (x = red, y = green, z = blue), plus
 * its edge size. 1D tables are resampled per channel, which a trilinear
 * lookup then reproduces exactly along each axis.
 */
export function lutVolume(lut) {
  if (lut.kind === '3d') {
    const count = lut.size ** 3;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      out[i * 4] = lut.data[i * 3];
      out[i * 4 + 1] = lut.data[i * 3 + 1];
      out[i * 4 + 2] = lut.data[i * 3 + 2];
      out[i * 4 + 3] = 1;
    }
    return { size: lut.size, data: out };
  }
  const n = Math.min(VOLUME_FOR_1D * 2 - 1, Math.max(VOLUME_FOR_1D, Math.min(65, lut.size)));
  const out = new Float32Array(n * n * n * 4);
  const axis = [0, 1, 2].map((ch) => Float32Array.from({ length: n }, (_, i) => sample1D(lut.data, lut.size, ch, i / (n - 1))));
  let o = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        out[o++] = axis[0][r];
        out[o++] = axis[1][g];
        out[o++] = axis[2][b];
        out[o++] = 1;
      }
    }
  }
  return { size: n, data: out };
}

/**
 * Apply a parsed LUT to one color on the CPU (trilinear for 3D), for tests
 * and analysis. rgb in the LUT's input domain.
 */
export function applyLut(lut, rgb) {
  const t = rgb.map((v, k) => (v - lut.domainMin[k]) / (lut.domainMax[k] - lut.domainMin[k]));
  if (lut.kind === '1d') return [0, 1, 2].map((ch) => sample1D(lut.data, lut.size, ch, t[ch]));
  const s = lut.size;
  const p = t.map((v) => Math.min(1, Math.max(0, v)) * (s - 1));
  const i = p.map((v) => Math.min(s - 2, Math.floor(v)));
  const f = p.map((v, k) => v - i[k]);
  const at = (r, g, b, ch) => lut.data[((b * s + g) * s + r) * 3 + ch];
  return [0, 1, 2].map((ch) => {
    let acc = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
          acc += w * at(i[0] + dx, i[1] + dy, i[2] + dz, ch);
        }
      }
    }
    return acc;
  });
}

/** A readable name for a LUT: its TITLE, else the file name without extension. */
export function lutName(lut, fileName = '') {
  return (lut.title || String(fileName).replace(/\.cube$/i, '') || 'LUT').slice(0, 120);
}
