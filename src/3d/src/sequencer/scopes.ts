// Preview scopes: histogram, luma waveform and chroma vectorscope of the shown frame. The data
// is computed from 8-bit RGBA pixels (pure, unit tested) and drawn into a region.

export type ScopeMode = 'IMAGE' | 'HISTOGRAM' | 'WAVEFORM' | 'VECTOR_SCOPE';

export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 256-bin counts per channel: [r, g, b, luma]. */
export function histogram(px: Uint8ClampedArray): Uint32Array[] {
  const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < px.length; i += 4) {
    h[0][px[i]]++;
    h[1][px[i + 1]]++;
    h[2][px[i + 2]]++;
    h[3][Math.round(luma(px[i], px[i + 1], px[i + 2]))]++;
  }
  return h;
}

/** Luma waveform: counts per (column, 256 levels), columns = image width. */
export function waveform(px: Uint8ClampedArray, w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * 256);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[x * 256 + Math.round(luma(px[i], px[i + 1], px[i + 2]))]++;
    }
  return out;
}

/** Chroma (Cb, Cr) of an 8-bit colour, each in −0.5..0.5. */
export function chroma(r: number, g: number, b: number): [number, number] {
  const R = r / 255,
    G = g / 255,
    B = b / 255;
  const Y = luma(R, G, B);
  return [(B - Y) / 1.8556, (R - Y) / 1.5748];
}

/** Vectorscope: counts on an n×n grid of (Cb, Cr). */
export function vectorscope(px: Uint8ClampedArray, n = 256): Uint32Array {
  const out = new Uint32Array(n * n);
  for (let i = 0; i < px.length; i += 4) {
    const [u, v] = chroma(px[i], px[i + 1], px[i + 2]);
    const x = Math.max(0, Math.min(n - 1, Math.round((u + 0.5) * (n - 1)))),
      y = Math.max(0, Math.min(n - 1, Math.round((0.5 - v) * (n - 1))));
    out[y * n + x]++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// drawing

const FONT = '10px Inter, system-ui, sans-serif';

function graticule(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lines: number[]) {
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 1;
  g.font = FONT;
  g.fillStyle = 'rgba(255,255,255,0.4)';
  for (const t of lines) {
    const yy = Math.round(y + h - t * h) + 0.5;
    g.beginPath();
    g.moveTo(x, yy);
    g.lineTo(x + w, yy);
    g.stroke();
    g.fillText(String(Math.round(t * 100)), x + 3, yy - 2);
  }
}

/** Draw a scope of the pixels into the rectangle (canvas pixels). */
export function drawScope(g: CanvasRenderingContext2D, mode: ScopeMode, px: Uint8ClampedArray, pw: number, ph: number, x: number, y: number, w: number, h: number) {
  g.save();
  g.fillStyle = '#101010';
  g.fillRect(x, y, w, h);
  if (mode === 'HISTOGRAM') {
    const hist = histogram(px);
    const max = Math.max(1, ...hist.slice(0, 3).map((c) => Math.max(...c.subarray(1, 255))));
    g.globalCompositeOperation = 'lighter';
    const cols = ['rgba(255,60,60,0.7)', 'rgba(60,255,60,0.7)', 'rgba(70,110,255,0.7)'];
    for (let c = 0; c < 3; c++) {
      g.fillStyle = cols[c];
      g.beginPath();
      g.moveTo(x, y + h);
      for (let i = 0; i < 256; i++) g.lineTo(x + (i / 255) * w, y + h - Math.min(1, hist[c][i] / max) * h * 0.95);
      g.lineTo(x + w, y + h);
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    graticule(g, x, y, w, h, []);
  } else if (mode === 'WAVEFORM') {
    const wf = waveform(px, pw, ph);
    const img = g.createImageData(pw, 256);
    const scale = 255 / Math.max(1, ph / 12);
    for (let c = 0; c < pw; c++)
      for (let l = 0; l < 256; l++) {
        const n = wf[c * 256 + l];
        if (!n) continue;
        const i = ((255 - l) * pw + c) * 4;
        const v = Math.min(255, 40 + n * scale);
        img.data[i] = v * 0.7;
        img.data[i + 1] = v;
        img.data[i + 2] = v * 0.7;
        img.data[i + 3] = 255;
      }
    const tmp = document.createElement('canvas');
    tmp.width = pw;
    tmp.height = 256;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, x, y, w, h);
    graticule(g, x, y, w, h, [0, 0.25, 0.5, 0.75, 1]);
  } else if (mode === 'VECTOR_SCOPE') {
    const n = 256;
    const vs = vectorscope(px, n);
    const side = Math.min(w, h) - 16;
    const ox = x + (w - side) / 2,
      oy = y + (h - side) / 2;
    const img = g.createImageData(n, n);
    const scale = 255 / Math.max(1, (pw * ph) / 4000);
    for (let i = 0; i < n * n; i++) {
      const c = vs[i];
      if (!c) continue;
      const v = Math.min(255, 60 + c * scale);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = n;
    tmp.height = n;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    // graticule: circle and the primary / secondary colour targets
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.arc(ox + side / 2, oy + side / 2, side / 2, 0, Math.PI * 2);
    g.moveTo(ox, oy + side / 2);
    g.lineTo(ox + side, oy + side / 2);
    g.moveTo(ox + side / 2, oy);
    g.lineTo(ox + side / 2, oy + side);
    g.stroke();
    g.drawImage(tmp, ox, oy, side, side);
    g.font = FONT;
    for (const [label, rgb] of [
      ['R', [255, 0, 0]],
      ['Y', [255, 255, 0]],
      ['G', [0, 255, 0]],
      ['C', [0, 255, 255]],
      ['B', [0, 0, 255]],
      ['M', [255, 0, 255]],
    ] as const) {
      const [u, v] = chroma(rgb[0], rgb[1], rgb[2]);
      const tx = ox + (u + 0.5) * side,
        ty = oy + (0.5 - v) * side;
      g.strokeStyle = `rgb(${rgb.join(',')})`;
      g.strokeRect(tx - 4, ty - 4, 8, 8);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(label, tx + 6, ty + 3);
    }
  }
  g.restore();
}
