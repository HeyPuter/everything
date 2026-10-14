// Textures for picture fills, drawn here from seeded noise so they are the
// app's own: each is a small tile that repeats seamlessly, made once and
// kept as PNG bytes for the file.

export const TEXTURES = [
  ["paper", "Paper"],
  ["linen", "Linen"],
  ["canvas", "Canvas"],
  ["denim", "Denim"],
  ["cork", "Cork"],
  ["sand", "Sand"],
  ["wood", "Wood grain"],
  ["marble", "Marble"],
  ["slate", "Slate"],
  ["recycled", "Recycled paper"],
];

const SIZE = 128;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable value noise on a periodic lattice.
function noiseField(seed, period) {
  const rand = rng(seed);
  const grid = Array.from({ length: period * period }, rand);
  const at = (x, y) =>
    grid[
      (((y % period) + period) % period) * period +
        (((x % period) + period) % period)
    ];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / SIZE) * period,
      fy = (y / SIZE) * period;
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy);
    const tx = smooth(fx - x0),
      ty = smooth(fy - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}
function fbm(seed, octaves = 4, base = 4) {
  const layers = Array.from({ length: octaves }, (_, i) =>
    noiseField(seed + i * 101, base << i),
  );
  return (x, y) => {
    let sum = 0,
      amp = 0.5,
      norm = 0;
    for (const layer of layers) {
      sum += layer(x, y) * amp;
      norm += amp;
      amp /= 2;
    }
    return sum / norm;
  };
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Pixel colors of a texture, as [r, g, b] for each of SIZE×SIZE pixels. */
export function texturePixels(id) {
  const n = fbm(id.length * 977 + id.charCodeAt(0));
  const fine = noiseField(31 + id.length, 64);
  const rand = rng(7 + id.charCodeAt(1));
  const px = (x, y) => {
    switch (id) {
      case "linen": {
        const w = ((x % 4 < 2) ^ (y % 4 < 2) ? 0.06 : 0) + fine(x, y) * 0.12;
        return mix([238, 232, 218], [205, 196, 176], w + n(x, y) * 0.3);
      }
      case "canvas": {
        const weave =
          Math.abs(Math.sin((x * Math.PI) / 3)) *
          Math.abs(Math.sin((y * Math.PI) / 3));
        return mix(
          [226, 214, 190],
          [178, 160, 128],
          weave * 0.45 + n(x, y) * 0.3,
        );
      }
      case "denim": {
        const twill = ((x + y) % 4 < 2 ? 0.35 : 0) + fine(x, y) * 0.3;
        return mix([60, 92, 140], [28, 46, 82], twill + n(x, y) * 0.25);
      }
      case "cork": {
        const speck = rand() < 0.08 ? 0.6 : 0;
        return mix([196, 150, 98], [120, 80, 44], n(x, y) * 0.7 + speck);
      }
      case "sand":
        return mix(
          [232, 212, 170],
          [196, 168, 118],
          n(x, y) * 0.5 + rand() * 0.3,
        );
      case "wood": {
        const ring =
          Math.sin((y / SIZE) * Math.PI * 2 * 6 + n(x, y) * 6) * 0.5 + 0.5;
        return mix(
          [200, 150, 96],
          [140, 92, 50],
          ring * 0.7 + fine(x, y) * 0.2,
        );
      }
      case "marble": {
        const vein = Math.abs(
          Math.sin(((x + y) / SIZE) * Math.PI * 2 * 2 + n(x, y) * 8),
        );
        return mix([92, 96, 104], [246, 246, 244], Math.pow(vein, 0.35));
      }
      case "slate":
        return mix(
          [70, 78, 86],
          [40, 46, 54],
          n(x, y) * 0.8 + fine(x, y) * 0.2,
        );
      case "recycled": {
        const fleck = rand() < 0.02 ? 0.5 : 0;
        return mix([224, 218, 204], [170, 160, 140], n(x, y) * 0.35 + fleck);
      }
      default:
        return mix(
          [248, 246, 240],
          [222, 218, 206],
          n(x, y) * 0.5 + fine(x, y) * 0.15,
        );
    }
  };
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = px(x, y);
      const i = (y * SIZE + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  return out;
}

const cache = new Map();
/** PNG bytes of a texture tile (made with a canvas in the browser). */
export function textureBytes(id) {
  if (cache.has(id)) return cache.get(id);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const context = canvas.getContext("2d");
  context.putImageData(new ImageData(texturePixels(id), SIZE, SIZE), 0, 0);
  const data = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  cache.set(id, bytes);
  return bytes;
}
