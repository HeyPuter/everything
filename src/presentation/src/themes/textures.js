// Textures for picture backgrounds: small seamless tiles drawn here with a
// canvas (noise, fibres, grain and weaves), turned into PNG pictures that
// the background tiles across the slide.

const SIZE = 128;

// A small seeded random number generator, so a texture is the same each time.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Draws each mark at the tile's edges too, so tiles meet without seams.
function wrap(ctx, draw) {
  for (const dx of [-SIZE, 0, SIZE])
    for (const dy of [-SIZE, 0, SIZE]) {
      ctx.save();
      ctx.translate(dx, dy);
      draw();
      ctx.restore();
    }
}

function speckle(ctx, rnd, count, colors, size = [0.5, 1.6]) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * SIZE,
      y = rnd() * SIZE,
      r = size[0] + rnd() * (size[1] - size[0]);
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    wrap(ctx, () => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function fibres(ctx, rnd, count, color, length = 30, angle = null) {
  ctx.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rnd() * SIZE,
      y = rnd() * SIZE;
    const a = angle ?? rnd() * Math.PI;
    const len = length * (0.4 + rnd() * 0.6);
    ctx.lineWidth = 0.4 + rnd() * 0.8;
    wrap(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 4,
        y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 4,
        x + Math.cos(a) * len,
        y + Math.sin(a) * len,
      );
      ctx.stroke();
    });
  }
}

function weave(ctx, a, b, step = 8) {
  for (let y = 0; y < SIZE; y += step)
    for (let x = 0; x < SIZE; x += step) {
      const over = (x / step + y / step) % 2 === 0;
      ctx.fillStyle = over ? a : b;
      ctx.fillRect(x, y, step, step);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      if (over) ctx.fillRect(x, y + 1, step, 1.2);
      else ctx.fillRect(x + 1, y, 1.2, step);
    }
}

/** The textures on offer: a name and how to draw one tile. */
export const TEXTURES = [
  {
    id: "paper",
    name: "Paper",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#f6f1e7";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(
        ctx,
        rnd,
        900,
        ["rgba(120,100,70,0.07)", "rgba(255,255,255,0.5)"],
        [0.3, 1],
      );
      fibres(ctx, rnd, 60, "rgba(140,120,90,0.12)", 26);
    },
  },
  {
    id: "parchment",
    name: "Parchment",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#ead8b0";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(ctx, rnd, 60, ["rgba(160,110,40,0.10)"], [4, 12]);
      speckle(ctx, rnd, 700, ["rgba(110,80,30,0.08)"], [0.3, 1]);
    },
  },
  {
    id: "linen",
    name: "Linen",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#e9e4d8";
      ctx.fillRect(0, 0, SIZE, SIZE);
      fibres(ctx, rnd, 180, "rgba(120,110,90,0.18)", 40, 0);
      fibres(ctx, rnd, 180, "rgba(120,110,90,0.14)", 40, Math.PI / 2);
    },
  },
  {
    id: "canvas",
    name: "Woven Canvas",
    draw: (ctx, rnd) => {
      weave(ctx, "#d9cfb9", "#cfc3aa", 4);
      speckle(ctx, rnd, 300, ["rgba(90,70,40,0.08)"], [0.3, 0.9]);
    },
  },
  {
    id: "denim",
    name: "Denim",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#3d5a80";
      ctx.fillRect(0, 0, SIZE, SIZE);
      fibres(ctx, rnd, 420, "rgba(255,255,255,0.16)", 14, Math.PI / 4);
      fibres(ctx, rnd, 200, "rgba(10,20,40,0.25)", 14, Math.PI / 4);
    },
  },
  {
    id: "sand",
    name: "Sand",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#e3cfa4";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(
        ctx,
        rnd,
        1800,
        [
          "rgba(150,110,50,0.18)",
          "rgba(255,250,235,0.35)",
          "rgba(110,80,40,0.12)",
        ],
        [0.4, 1.1],
      );
    },
  },
  {
    id: "cork",
    name: "Cork",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#b9875a";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(
        ctx,
        rnd,
        500,
        ["rgba(90,50,20,0.35)", "rgba(230,190,140,0.35)"],
        [0.8, 2.6],
      );
    },
  },
  {
    id: "wood",
    name: "Wood Grain",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#c79a6b";
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 26; i++) {
        const y = rnd() * SIZE;
        ctx.strokeStyle = `rgba(110,65,30,${0.15 + rnd() * 0.25})`;
        ctx.lineWidth = 0.6 + rnd() * 1.6;
        wrap(ctx, () => {
          ctx.beginPath();
          ctx.moveTo(0, y);
          for (let x = 0; x <= SIZE; x += 16)
            ctx.lineTo(x, y + Math.sin((x / SIZE) * Math.PI * 2 + i) * 3);
          ctx.stroke();
        });
      }
    },
  },
  {
    id: "slate",
    name: "Slate",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#4a5058";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(
        ctx,
        rnd,
        40,
        ["rgba(255,255,255,0.05)", "rgba(0,0,0,0.08)"],
        [6, 18],
      );
      speckle(
        ctx,
        rnd,
        900,
        ["rgba(255,255,255,0.08)", "rgba(0,0,0,0.1)"],
        [0.3, 1],
      );
    },
  },
  {
    id: "marble",
    name: "Marble",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#f1f0ee";
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 9; i++) {
        let x = rnd() * SIZE,
          y = rnd() * SIZE;
        ctx.strokeStyle = `rgba(120,125,135,${0.12 + rnd() * 0.2})`;
        ctx.lineWidth = 0.5 + rnd() * 1.2;
        const points = [[x, y]];
        for (let k = 0; k < 8; k++) {
          x += 6 + rnd() * 12;
          y += (rnd() - 0.5) * 18;
          points.push([x, y]);
        }
        wrap(ctx, () => {
          ctx.beginPath();
          points.forEach(([px, py], j) =>
            j ? ctx.lineTo(px, py) : ctx.moveTo(px, py),
          );
          ctx.stroke();
        });
      }
    },
  },
  {
    id: "mesh",
    name: "Mesh",
    draw: (ctx) => {
      ctx.fillStyle = "#dfe6ec";
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = "rgba(60,80,100,0.22)";
      ctx.lineWidth = 1;
      for (let i = -SIZE; i < SIZE * 2; i += 8) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + SIZE, SIZE);
        ctx.moveTo(i, SIZE);
        ctx.lineTo(i + SIZE, 0);
        ctx.stroke();
      }
    },
  },
  {
    id: "terrazzo",
    name: "Terrazzo",
    draw: (ctx, rnd) => {
      ctx.fillStyle = "#efe9e1";
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(
        ctx,
        rnd,
        70,
        ["#c9a68a", "#8fa3a0", "#d8c39a", "#a9a9b5"],
        [1.5, 4],
      );
      speckle(ctx, rnd, 300, ["rgba(90,90,90,0.25)"], [0.3, 0.8]);
    },
  },
];

/** A canvas with the texture drawn on it, or null without a DOM. */
export function textureCanvas(id) {
  const texture = TEXTURES.find((t) => t.id === id);
  if (!texture || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const rnd = random(
    [...texture.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7),
  );
  texture.draw(ctx, rnd);
  return canvas;
}

const swatches = new Map();
/** A data URL of the texture, for its button. */
export function textureSwatch(id) {
  if (!swatches.has(id)) swatches.set(id, textureCanvas(id)?.toDataURL() || "");
  return swatches.get(id);
}

/** The texture as PNG bytes. */
export async function textureBytes(id) {
  const canvas = textureCanvas(id);
  if (!canvas) throw new Error("Textures need a browser.");
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
