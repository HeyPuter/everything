/**
 * In-place-ish image filters for scanned pages. Each returns a new
 * Uint8ClampedArray of RGBA pixels.
 */

export function applyFilter(rgba, width, height, name = 'original') {
  switch (name) {
    case 'grayscale':
      return grayscale(rgba);
    case 'contrast':
      return contrast(rgba, 1.35);
    case 'document':
      return documentLook(rgba, width, height);
    case 'threshold':
      return threshold(rgba, 180);
    case 'original':
    default:
      return rgba.slice();
  }
}

export function grayscale(rgba) {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) {
    const y = Math.round(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]);
    out[i] = out[i + 1] = out[i + 2] = y;
  }
  return out;
}

export function contrast(rgba, amount = 1.3) {
  const out = rgba.slice();
  const factor = (259 * (amount * 255 + 255)) / (255 * (259 - amount * 255));
  const adj = (v) => clamp(factor * (v - 128) + 128);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = adj(out[i]);
    out[i + 1] = adj(out[i + 1]);
    out[i + 2] = adj(out[i + 2]);
  }
  return out;
}

/** High-contrast B&W suited to printed text. */
export function documentLook(rgba, width, height) {
  const gray = grayscale(rgba);
  // Local mean threshold (box ~15px) for mild shadow resistance.
  const radius = 7;
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += gray[(yy * width + xx) * 4];
          n += 1;
        }
      }
      const mean = sum / Math.max(1, n);
      const i = (y * width + x) * 4;
      const v = gray[i] < mean - 8 ? 0 : 255;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

export function threshold(rgba, cut = 160) {
  const gray = grayscale(rgba);
  for (let i = 0; i < gray.length; i += 4) {
    const v = gray[i] < cut ? 0 : 255;
    gray[i] = gray[i + 1] = gray[i + 2] = v;
  }
  return gray;
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
