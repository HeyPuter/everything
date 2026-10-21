// Test patterns of generated images (Image ▸ New ▸ UV Grid / Color Grid), drawn on a 2D canvas.
// Pure drawing: both depend only on the canvas size.

/** RGB (0–255) of an HSV colour (h in turns). */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/**
 * UV Grid: a 32 × 32 checker of mid greys (the bottom-left cell light) with a small cross in the
 * middle of each cell whose hue steps by 45° along the diagonals, so that stretching and flipped
 * or rotated islands are easy to spot.
 */
export function drawUVGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const n = 32;
  const cw = w / n,
    ch = h / n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = (i + j) % 2 === 0 ? 'rgb(150, 150, 150)' : 'rgb(64, 64, 64)';
      const x0 = Math.round(i * cw),
        y0 = Math.round(h - (j + 1) * ch);
      ctx.fillRect(x0, y0, Math.round((i + 1) * cw) - x0, Math.round(h - j * ch) - y0);
    }
  const arm = Math.max(1, Math.round(Math.min(cw, ch) * 0.1));
  const t = Math.max(1, Math.round(Math.min(cw, ch) / 32));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [r, g, b] = hsvToRgb(((i + j) % 8) / 8, 0.9, 0.9);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      const cx = Math.floor(i * cw + cw / 2),
        cy = Math.floor(h - j * ch - ch / 2);
      ctx.fillRect(cx - arm, cy - Math.floor(t / 2), arm * 2 + 1, t);
      ctx.fillRect(cx - Math.floor(t / 2), cy - arm, t, arm * 2 + 1);
    }
}

/**
 * Color Grid: 8 × 8 labelled cells (rows A–H from the bottom, columns 1–8). Each column has its
 * own hue and colours get more saturated upwards; a faint 4 × 4 checker and grid lines inside each
 * cell show the texel scale.
 */
export function drawColorGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const n = 8,
    sub = 4;
  const cw = w / n,
    ch = h / n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const sat = 0.22 + (0.6 * j) / (n - 1);
      for (let b = 0; b < sub; b++)
        for (let a = 0; a < sub; a++) {
          const v = (a + b) % 2 === 0 ? 0.62 : 0.5;
          const [r, g, bl] = hsvToRgb(i / n, sat, v + (0.12 * j) / (n - 1));
          ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
          const x0 = Math.round(i * cw + (a * cw) / sub),
            x1 = Math.round(i * cw + ((a + 1) * cw) / sub);
          const y1 = Math.round(h - j * ch - (b * ch) / sub),
            y0 = Math.round(h - j * ch - ((b + 1) * ch) / sub);
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
    }
  // grid lines: fine ones every half checker square, stronger ones between cells
  ctx.save();
  const fine = n * sub * 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  const lw = Math.max(1, Math.round(w / 1024));
  for (let k = 0; k <= fine; k++) {
    const x = Math.round((k * w) / fine),
      y = Math.round((k * h) / fine);
    ctx.fillRect(Math.min(w - lw, x), 0, lw, h);
    ctx.fillRect(0, Math.min(h - lw, y), w, lw);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  for (let k = 0; k <= n; k++) {
    ctx.fillRect(Math.min(w - lw, Math.round((k * w) / n)), 0, lw, h);
    ctx.fillRect(0, Math.min(h - lw, Math.round((k * h) / n)), w, lw);
  }
  // labels
  const size = Math.max(6, Math.round(ch * 0.36));
  ctx.font = `${size}px "DejaVu Sans Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size * 0.09);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#ffffff';
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const label = `${String.fromCharCode(65 + j)}${i + 1}`;
      const x = i * cw + cw / 2,
        y = h - j * ch - ch / 2;
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
    }
  ctx.restore();
}
