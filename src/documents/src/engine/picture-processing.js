/**
 * Pixel processing for Picture Format: background removal, artistic effects, colour adjustments and
 * the resampling Compress Pictures uses. Every function takes and returns `{ data, width, height }`
 * (RGBA bytes, as in ImageData), never changes its input and needs no DOM, so results are
 * deterministic and testable. All algorithms here are original to this project.
 */

const clamp = (v, lo = 0, hi = 255) => v < lo ? lo : v > hi ? hi : v;
const blank = (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
const copy = image => ({ data: new Uint8ClampedArray(image.data), width: image.width, height: image.height });

function check(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.data?.length !== image.width * image.height * 4) throw new Error('Expected RGBA pixels with a positive width and height.');
}

/* ---- Colour space ---- */

// sRGB byte → linear light, once per byte value.
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const labF = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

/** Lab coordinates (D65) of every pixel: Float32Array of 3 per pixel. */
function labPixels(image) {
  const { data } = image, n = image.width * image.height, lab = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LINEAR[data[j]], g = LINEAR[data[j + 1]], b = LINEAR[data[j + 2]];
    const x = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = labF(0.2126 * r + 0.7152 * g + 0.0722 * b), z = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    lab[i * 3] = 116 * y - 16; lab[i * 3 + 1] = 500 * (x - y); lab[i * 3 + 2] = 200 * (y - z);
  }
  return lab;
}

/** A few representative colours of the listed pixels (deterministic k-means in Lab). */
function colourClusters(lab, indices, k = 6, iterations = 6) {
  if (!indices.length) return [];
  const step = Math.max(1, Math.floor(indices.length / 4000)), samples = [];
  for (let i = 0; i < indices.length; i += step) samples.push(indices[i]);
  k = Math.min(k, samples.length);
  const centres = Array.from({ length: k }, (_, c) => { const p = samples[Math.floor((c + 0.5) * samples.length / k)] * 3; return [lab[p], lab[p + 1], lab[p + 2]]; });
  const sums = centres.map(() => [0, 0, 0, 0]);
  for (let pass = 0; pass < iterations; pass++) {
    for (const s of sums) s.fill(0);
    for (const index of samples) {
      const p = index * 3; let best = 0, bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (lab[p] - centres[c][0]) ** 2 + (lab[p + 1] - centres[c][1]) ** 2 + (lab[p + 2] - centres[c][2]) ** 2;
        if (d < bestDistance) { bestDistance = d; best = c; }
      }
      const s = sums[best]; s[0] += lab[p]; s[1] += lab[p + 1]; s[2] += lab[p + 2]; s[3]++;
    }
    for (let c = 0; c < k; c++) if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
  }
  // Clusters that drew no samples are duplicates of a starting point; drop them.
  return centres.filter((_, c) => sums[c][3] > 0);
}
const nearest = (lab, p, centres) => {
  let best = Infinity;
  for (const c of centres) { const d = (lab[p] - c[0]) ** 2 + (lab[p + 1] - c[1]) ** 2 + (lab[p + 2] - c[2]) ** 2; if (d < best) best = d; }
  return Math.sqrt(best);
};

/* ---- Marks ---- */

/** Paint strokes ({ points: [[x, y]] in 0..1, radius in 0..1 of the shorter side }) into `target` with `value`. */
function rasterStrokes(target, width, height, strokes, value) {
  const side = Math.min(width, height);
  for (const stroke of strokes || []) {
    const points = (stroke.points || []).map(([x, y]) => [x * width, y * height]);
    if (!points.length) continue;
    const r = Math.max(0.5, (stroke.radius ?? 0.02) * side), r2 = r * r;
    const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
    for (const [[ax, ay], [bx, by]] of segments) {
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = length2 ? clamp(((px - ax) * dx + (py - ay) * dy) / length2, 0, 1) : 0;
        if ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= r2) target[y * width + x] = value;
      }
    }
  }
}

/** Mean Lab colour of the pixels a mark covers, per connected stroke set. */
function markColours(lab, marks, value) {
  const indices = [];
  for (let i = 0; i < marks.length; i++) if (marks[i] === value) indices.push(i);
  return colourClusters(lab, indices, 4, 4);
}

/* ---- Background removal ---- */

const DEFAULT_REGION = Object.freeze({ left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 });
const KEEP = 1, REMOVE = 2;

/**
 * Separate a picture's subject from its background.
 *
 * The colours outside the subject area (and along the picture's edges) model the background. Background
 * grows from the edges, from outside the subject area and from "remove" marks through pixels close to
 * that model; "keep" marks block it and win back nearby pixels of their own colours, "remove" marks claim
 * nearby pixels of theirs. Small islands and holes are then cleaned up and the edge is feathered.
 *
 * Returns { mask (0..255 per pixel, 255 = keep), region }.
 */
export function removeBackground(image, { keep = [], remove = [], sensitivity = 0.5, region = null } = {}) {
  check(image);
  const { width, height, data } = image, n = width * height;
  const box = normalizeRegion(region);
  const rx0 = Math.floor(box.left * width), rx1 = Math.ceil(box.right * width), ry0 = Math.floor(box.top * height), ry1 = Math.ceil(box.bottom * height);
  const inside = i => { const x = i % width, y = (i / width) | 0; return x >= rx0 && x < rx1 && y >= ry0 && y < ry1; };
  const lab = labPixels(image);

  // Background colour model: pixels outside the subject area, or the outer band when it covers everything.
  let sample = [];
  for (let i = 0; i < n; i++) if (!inside(i) && data[i * 4 + 3] > 16) sample.push(i);
  if (sample.length < 32) {
    sample = [];
    const band = Math.max(1, Math.round(Math.min(width, height) * 0.02));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((x < band || y < band || x >= width - band || y >= height - band) && data[(y * width + x) * 4 + 3] > 16) sample.push(y * width + x);
  }
  const background = colourClusters(lab, sample, 6);
  const s = clamp(Number(sensitivity) || 0, 0, 1);
  const threshold = 6 + s * 30;
  const distance = new Float32Array(n);
  for (let i = 0; i < n; i++) distance[i] = background.length ? nearest(lab, i * 3, background) : Infinity;

  const marks = new Uint8Array(n);
  rasterStrokes(marks, width, height, keep, KEEP);
  rasterStrokes(marks, width, height, remove, REMOVE);

  // 1 = background, 0 = subject.
  const removed = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  const passable = i => marks[i] !== KEEP && (distance[i] < (inside(i) ? threshold : threshold * 2.5) || data[i * 4 + 3] <= 16);
  const seed = i => { if (!removed[i]) { removed[i] = 1; queue[tail++] = i; } };
  for (let i = 0; i < n; i++) {
    if (marks[i] === REMOVE || data[i * 4 + 3] <= 16) seed(i);
    else if (marks[i] !== KEEP && !inside(i) && distance[i] < threshold * 2.5) seed(i);
  }
  for (let x = 0; x < width; x++) for (const y of [0, height - 1]) { const i = y * width + x; if (passable(i)) seed(i); }
  for (let y = 0; y < height; y++) for (const x of [0, width - 1]) { const i = y * width + x; if (passable(i)) seed(i); }
  const flood = (canEnter, mark) => {
    while (head < tail) {
      const i = queue[head++], x = i % width;
      if (x > 0 && canEnter(i - 1)) { mark(i - 1); queue[tail++] = i - 1; }
      if (x < width - 1 && canEnter(i + 1)) { mark(i + 1); queue[tail++] = i + 1; }
      if (i >= width && canEnter(i - width)) { mark(i - width); queue[tail++] = i - width; }
      if (i < n - width && canEnter(i + width)) { mark(i + width); queue[tail++] = i + width; }
    }
  };
  flood(i => !removed[i] && passable(i), i => { removed[i] = 1; });

  // Marks claim neighbouring pixels of their own colours.
  const grow = (value, target) => {
    const colours = markColours(lab, marks, value);
    if (!colours.length) return;
    head = tail = 0;
    for (let i = 0; i < n; i++) if (marks[i] === value) { removed[i] = target; queue[tail++] = i; }
    const limit = threshold * 1.2;
    flood(i => removed[i] !== target && marks[i] !== (value === KEEP ? REMOVE : KEEP) && nearest(lab, i * 3, colours) < limit, i => { removed[i] = target; });
  };
  grow(KEEP, 0);
  grow(REMOVE, 1);

  cleanUp(removed, marks, width, height);
  return { mask: feather(removed, marks, width, height), region: box };
}

function normalizeRegion(region) {
  if (!region) return { ...DEFAULT_REGION };
  const r = { left: clamp(+region.left || 0, 0, 1), top: clamp(+region.top || 0, 0, 1), right: clamp(+(region.right ?? 1), 0, 1), bottom: clamp(+(region.bottom ?? 1), 0, 1) };
  if (r.right - r.left < 0.01 || r.bottom - r.top < 0.01) return { ...DEFAULT_REGION };
  return r;
}

/** Remove small subject islands and fill small background holes (4-connected components). */
function cleanUp(removed, marks, width, height) {
  const n = width * height, minimum = Math.max(16, Math.round(n * 0.0005));
  const seen = new Uint8Array(n), queue = new Int32Array(n), members = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const value = removed[start];
    let head = 0, tail = 0, count = 0, edge = false, marked = false;
    seen[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++], x = i % width, y = (i / width) | 0;
      members[count++] = i;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      if (marks[i]) marked = true;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && !seen[j] && removed[j] === value) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (count >= minimum || marked) continue;
    // A small subject island is noise; a small background hole away from the edges is part of the subject.
    if (value === 0 || !edge) for (let m = 0; m < count; m++) removed[members[m]] = value ? 0 : 1;
  }
}

/** The alpha mask: background 0, subject 255, with a soft one- or two-pixel edge. Marked pixels stay hard. */
function feather(removed, marks, width, height) {
  const n = width * height, passes = n > 1000000 ? 2 : 1;
  let alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = removed[i] ? 0 : 255;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(n);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= height) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= width) continue; sum += alpha[yy * width + xx]; count++; } }
      next[y * width + x] = sum / count;
    }
    alpha = next;
  }
  const mask = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) mask[i] = marks[i] === KEEP ? 255 : marks[i] === REMOVE ? 0 : Math.round(alpha[i]);
  return mask;
}

/** The picture with its alpha multiplied by the mask. */
export function applyMask(image, mask) {
  check(image);
  if (mask?.length !== image.width * image.height) throw new Error('The mask does not match the picture.');
  const out = copy(image);
  for (let i = 0; i < mask.length; i++) out.data[i * 4 + 3] = Math.round(out.data[i * 4 + 3] * mask[i] / 255);
  return out;
}

/* ---- Shared filter pieces ---- */

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function grayPlane(image) {
  const n = image.width * image.height, out = new Float32Array(n), d = image.data;
  for (let i = 0; i < n; i++) out[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return out;
}
/** Box blur of a single-channel plane with clamped edges (one pass horizontally, one vertically). */
function blurPlane(plane, width, height, radius) {
  if (radius < 1) return Float32Array.from(plane);
  const tmp = new Float32Array(plane.length), out = new Float32Array(plane.length), size = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width; let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += plane[row + clamp(k, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / size;
      sum += plane[row + Math.min(width - 1, x + radius + 1)] - plane[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}
/** Split into float planes (r, g, b, a). */
function planes(image) {
  const n = image.width * image.height, d = image.data, out = [0, 1, 2, 3].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) out[c][i] = d[i * 4 + c];
  return out;
}
function fromPlanes(width, height, [r, g, b], alphaFrom) {
  const out = blank(width, height), d = out.data;
  for (let i = 0; i < width * height; i++) { d[i * 4] = r[i]; d[i * 4 + 1] = g[i]; d[i * 4 + 2] = b[i]; d[i * 4 + 3] = alphaFrom.data[i * 4 + 3]; }
  return out;
}
/** Gaussian-like blur of a colour picture: three box passes per channel. */
function blurImage(image, radius) {
  const [r, g, b] = planes(image), { width, height } = image;
  const smooth = p => { let q = p; for (let i = 0; i < 3; i++) q = blurPlane(q, width, height, radius); return q; };
  return fromPlanes(width, height, [smooth(r), smooth(g), smooth(b)], image);
}
/** Edge strength (Sobel magnitude) of a plane, about 0..1000. */
function edges(plane, width, height) {
  const out = new Float32Array(plane.length), at = (x, y) => plane[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    out[y * width + x] = Math.hypot(gx, gy);
  }
  return out;
}
/** A seeded pseudo-random sequence, so grain and texture are the same every time. */
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const scaleFor = image => Math.max(1, Math.min(image.width, image.height) / 400);
const mapPixels = (image, fn) => {
  const out = copy(image), d = out.data;
  for (let i = 0, j = 0; j < d.length; i++, j += 4) { const [r, g, b] = fn(d[j], d[j + 1], d[j + 2], i); d[j] = r; d[j + 1] = g; d[j + 2] = b; }
  return out;
};
/** Pencil-shading: the picture divided by its blurred negative brightens flat areas and keeps strokes. */
function pencilShade(image, amount) {
  const { width, height } = image, gray = grayPlane(image);
  const inverse = gray.map(v => 255 - v);
  const soft = blurPlane(blurPlane(inverse, width, height, Math.round((2 + amount * 6) * scaleFor(image))), width, height, 1);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = clamp(gray[i] * 255 / Math.max(1, 255 - soft[i]));
  return out;
}

/** Edge-preserving smoothing: each pixel takes the mean of its calmest neighbouring quadrant. */
function calmestQuadrant(image, radius) {
  const { width, height } = image, n = width * height, [r, g, b] = planes(image), gray = grayPlane(image);
  const W = width + 1, table = p => {
    const sum = new Float64Array(W * (height + 1));
    for (let y = 0; y < height; y++) { let row = 0; for (let x = 0; x < width; x++) { row += p[y * width + x]; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; } }
    return sum;
  };
  const tables = [table(r), table(g), table(b), table(gray), table(gray.map(v => v * v))];
  const rect = (t, x0, y0, x1, y1) => t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0];
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let best = Infinity, choice = null;
    for (const [qx, qy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const x0 = clamp(qx ? x - radius : x, 0, width), x1 = clamp(qx ? x + 1 : x + radius + 1, 0, width);
      const y0 = clamp(qy ? y - radius : y, 0, height), y1 = clamp(qy ? y + 1 : y + radius + 1, 0, height);
      const count = (x1 - x0) * (y1 - y0); if (!count) continue;
      const mean = rect(tables[3], x0, y0, x1, y1) / count, variance = rect(tables[4], x0, y0, x1, y1) / count - mean * mean;
      if (variance < best) { best = variance; choice = [x0, y0, x1, y1, count]; }
    }
    const [x0, y0, x1, y1, count] = choice, i = y * width + x;
    for (let c = 0; c < 3; c++) out[c][i] = rect(tables[c], x0, y0, x1, y1) / count;
  }
  return fromPlanes(width, height, out, image);
}

/* ---- Artistic effects ---- */

const amountOf = amount => clamp(Number.isFinite(+amount) ? +amount : 0.5, 0, 1);

/**
 * Artistic effects, each baked into a new picture. `a14` names the extension element that records the
 * effect beside the original picture (MS-ODRAWXML picture effect layers); `amount` is 0..1.
 */
export const ARTISTIC_EFFECTS = Object.freeze([
  { id: 'blur', name: 'Soft Focus', a14: 'artisticBlur', apply(image, amount) {
    check(image); return blurImage(image, Math.round((1 + amountOf(amount) * 8) * scaleFor(image)));
  } },
  { id: 'pencilGray', name: 'Graphite Sketch', a14: 'artisticPencilGrayscale', apply(image, amount) {
    check(image); const shade = pencilShade(image, amountOf(amount));
    return mapPixels(image, (r, g, b, i) => [shade[i], shade[i], shade[i]]);
  } },
  { id: 'pencilSketch', name: 'Coloured Pencil', a14: 'artisticPencilSketch', apply(image, amount) {
    check(image); const shade = pencilShade(image, amountOf(amount));
    return mapPixels(image, (r, g, b, i) => {
      const y = luma(r, g, b), k = shade[i] / 255;
      // Colour at reduced saturation, multiplied by the pencil shading.
      return [r, g, b].map(c => clamp((y + (c - y) * 0.55) * k + 255 * (1 - k) * 0.08));
    });
  } },
  { id: 'lineDrawing', name: 'Ink Outline', a14: 'artisticLineDrawing', apply(image, amount) {
    check(image); const { width, height } = image, a = amountOf(amount);
    const edge = edges(blurPlane(grayPlane(image), width, height, Math.round(scaleFor(image))), width, height);
    const threshold = 220 - a * 160;
    return mapPixels(image, (r, g, b, i) => { const v = edge[i] > threshold ? clamp(255 - (edge[i] - threshold) * 2.5) : 255; return [v, v, v]; });
  } },
  { id: 'cutout', name: 'Paper Cutout', a14: 'artisticCutout', apply(image, amount) {
    check(image); const levels = Math.round(6 - amountOf(amount) * 3), step = 255 / (levels - 1);
    const smooth = calmestQuadrant(image, Math.round(2 * scaleFor(image)));
    return mapPixels(smooth, (r, g, b) => [r, g, b].map(c => Math.round(Math.round(c / step) * step)));
  } },
  { id: 'glowEdges', name: 'Neon Edges', a14: 'artisticGlowEdges', apply(image, amount) {
    check(image); const { width, height } = image, a = amountOf(amount);
    const edge = blurPlane(edges(grayPlane(image), width, height), width, height, 1), gain = (1.5 + a * 3) / 255;
    return mapPixels(image, (r, g, b, i) => {
      const k = clamp(edge[i] * gain, 0, 1.6), y = luma(r, g, b) || 1, boost = 255 / Math.max(r, g, b, 1);
      return [r, g, b].map(c => clamp(c * boost * k * (0.6 + 0.4 * c / y) * 0.9));
    });
  } },
  { id: 'filmGrain', name: 'Film Grain', a14: 'artisticFilmGrain', apply(image, amount) {
    check(image); const a = amountOf(amount), next = random(0x5EED + image.width * 31 + image.height), strength = 12 + a * 48;
    return mapPixels(image, (r, g, b) => {
      // Two uniform draws average to a softer, roughly bell-shaped grain.
      const grain = (next() + next() - 1) * strength;
      return [r, g, b].map(c => clamp((c - 128) * 1.08 + 128 + grain));
    });
  } },
  { id: 'photocopy', name: 'Photocopy', a14: 'artisticPhotocopy', apply(image, amount) {
    check(image); const { width, height } = image, a = amountOf(amount), gray = grayPlane(image);
    const local = blurPlane(gray, width, height, Math.round((3 + a * 6) * scaleFor(image)));
    return mapPixels(image, (r, g, b, i) => {
      // Dark where the picture is darker than its surroundings, with a narrow ramp for toner edges.
      const v = clamp(255 - (local[i] - gray[i] - 4 + a * 6) * 18);
      return [v, v, v];
    });
  } },
  { id: 'paintStrokes', name: 'Oil Paint', a14: 'artisticPaintStrokes', apply(image, amount) {
    check(image); return calmestQuadrant(image, Math.round((2 + amountOf(amount) * 5) * scaleFor(image)));
  } },
  { id: 'mosaicBubbles', name: 'Bubble Mosaic', a14: 'artisticMosiaicBubbles', apply(image, amount) {
    check(image); const { width, height } = image, cell = Math.max(3, Math.round((5 + amountOf(amount) * 12) * scaleFor(image)));
    const out = copy(image), d = image.data, o = out.data;
    for (let cy = 0; cy < height; cy += cell) for (let cx = 0; cx < width; cx += cell) {
      const x1 = Math.min(width, cx + cell), y1 = Math.min(height, cy + cell), sum = [0, 0, 0]; let count = 0;
      for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) { const j = (y * width + x) * 4; sum[0] += d[j]; sum[1] += d[j + 1]; sum[2] += d[j + 2]; count++; }
      const mean = sum.map(v => v / count), mx = (cx + x1) / 2, my = (cy + y1) / 2, radius = cell * 0.46;
      for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
        const j = (y * width + x) * 4, dist = Math.hypot(x + 0.5 - mx, y + 0.5 - my) / radius;
        // A bubble of the cell's colour with a highlight, on a darker grout.
        const k = dist > 1 ? 0.55 : 1 + 0.25 * Math.max(0, 1 - Math.hypot(x + 0.5 - (mx - radius * 0.35), y + 0.5 - (my - radius * 0.35)) / (radius * 0.45));
        for (let c = 0; c < 3; c++) o[j + c] = clamp(mean[c] * k);
      }
    }
    return out;
  } },
  { id: 'watercolor', name: 'Watercolour Wash', a14: 'artisticWatercolorSponge', apply(image, amount) {
    check(image); const { width, height } = image, a = amountOf(amount), scale = scaleFor(image);
    const washed = blurImage(calmestQuadrant(image, Math.round((2 + a * 3) * scale)), Math.round(scale));
    const edge = edges(grayPlane(washed), width, height), next = random(0xA11E + width * 7 + height * 13);
    return mapPixels(washed, (r, g, b, i) => {
      // Pigment pools at edges; the paper shows through elsewhere, with a little fibre texture.
      const pool = clamp(edge[i] / 600, 0, 0.35), paper = (next() - 0.5) * 10;
      return [r, g, b].map(c => clamp(255 - (255 - c) * (0.8 + pool) + paper));
    });
  } },
]);

/* ---- Colour adjustments ---- */

/** Saturation: 0 is gray, 1 unchanged, above 1 more vivid (up to 4). */
export function adjustSaturation(image, factor) {
  check(image); const k = clamp(Number(factor), 0, 4);
  return mapPixels(image, (r, g, b) => { const y = luma(r, g, b); return [r, g, b].map(c => clamp(y + (c - y) * k)); });
}

/**
 * White balance relative to daylight (6500 K): lower temperatures warm the picture (more red, less
 * blue), higher ones cool it. Range 1500–11500 K. Brightness is kept about the same.
 */
export function adjustTemperature(image, kelvin) {
  check(image);
  const t = clamp((6500 - clamp(Number(kelvin) || 6500, 1500, 11500)) / 5000, -1, 1);
  const gains = [1 + 0.32 * t, 1 + 0.06 * t, 1 - 0.32 * t];
  const norm = luma(...gains);
  return mapPixels(image, (r, g, b) => [r, g, b].map((c, i) => clamp(c * gains[i] / norm)));
}

/** Sharpen (amount > 0, an unsharp mask) or soften (amount < 0, a blur), amount in -1..1. */
export function sharpenSoften(image, amount) {
  check(image); const a = clamp(Number(amount) || 0, -1, 1);
  if (!a) return copy(image);
  const scale = scaleFor(image);
  if (a < 0) {
    const blurred = blurImage(image, Math.max(1, Math.round(scale * (1 + -a * 2))));
    return mapPixels(image, (r, g, b, i) => [r, g, b].map((c, k) => c + (blurred.data[i * 4 + k] - c) * -a));
  }
  const blurred = blurImage(image, Math.max(1, Math.round(scale)));
  return mapPixels(image, (r, g, b, i) => [r, g, b].map((c, k) => clamp(c + (c - blurred.data[i * 4 + k]) * a * 1.6)));
}

/* ---- Resampling ---- */

/** Scale down by area averaging (premultiplied alpha), scale in (0, 1]. */
export function downsample(image, scale) {
  check(image);
  const s = Number(scale);
  if (!(s > 0)) throw new Error('The scale must be positive.');
  if (s >= 1) return copy(image);
  const { width, height, data } = image, w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  // Horizontal pass into premultiplied floats, then vertical.
  const weights = (from, to) => {
    const ratio = from / to, spans = [];
    for (let o = 0; o < to; o++) {
      const start = o * ratio, end = (o + 1) * ratio, list = [];
      for (let i = Math.floor(start); i < Math.min(from, Math.ceil(end)); i++) {
        const cover = Math.min(end, i + 1) - Math.max(start, i);
        if (cover > 0) list.push([i, cover / ratio]);
      }
      spans.push(list);
    }
    return spans;
  };
  const xs = weights(width, w), ys = weights(height, h);
  const mid = new Float32Array(w * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (const [i, k] of xs[x]) {
      const j = (y * width + i) * 4, a = data[j + 3] / 255;
      mid[o] += data[j] * a * k; mid[o + 1] += data[j + 1] * a * k; mid[o + 2] += data[j + 2] * a * k; mid[o + 3] += data[j + 3] * k;
    }
  }
  const out = blank(w, h), d = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [i, k] of ys[y]) { const j = (i * w + x) * 4; r += mid[j] * k; g += mid[j + 1] * k; b += mid[j + 2] * k; a += mid[j + 3] * k; }
    const o = (y * w + x) * 4, alpha = a / 255;
    d[o] = alpha ? r / alpha : 0; d[o + 1] = alpha ? g / alpha : 0; d[o + 2] = alpha ? b / alpha : 0; d[o + 3] = a;
  }
  return out;
}

/** Keep only the visible part of a cropped picture: crop fractions of each side (negative outsets count as 0). */
export function cropPixels(image, { left = 0, top = 0, right = 0, bottom = 0 } = {}) {
  check(image);
  const { width, height } = image;
  const x0 = Math.round(clamp(left, 0, 1) * width), x1 = width - Math.round(clamp(right, 0, 1) * width);
  const y0 = Math.round(clamp(top, 0, 1) * height), y1 = height - Math.round(clamp(bottom, 0, 1) * height);
  if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('The crop leaves no picture.');
  const out = blank(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) out.data.set(image.data.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * out.width * 4);
  return out;
}
