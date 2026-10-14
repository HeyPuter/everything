// Transitions drawn with the 2D canvas: each effect paints one frame of the
// change from slide A (the one leaving) to slide B (the one arriving) at
// progress q, from 0 (all A) to 1 (all B).
//
// An effect receives `g`:
//   ctx        the 2D context of the transition canvas (device pixels)
//   W, H       its size
//   A, B       the two slides, rasterized at that size
//   o          the transition's effect attributes, format defaults filled in
//   q          progress
//   random(i)  a stable pseudo-random number in [0, 1) for piece i
//   scratch()  a reusable offscreen canvas the size of the slide
//   layers     for dynamic content effects: { A: {bg, fg}, B: {bg, fg} } or null

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t) => t * t * t;
export const smooth = (t) => t * t * (3 - 2 * t);
// Progress of a piece that starts at `start` and takes `span` of the whole.
export const local = (q, start, span) => clamp((q - start) / span);

/** Unit vector of a direction token: the way the motion goes. */
export const vector = (direction) =>
  ({
    l: [-1, 0],
    r: [1, 0],
    u: [0, -1],
    d: [0, 1],
    lu: [-1, -1],
    ru: [1, -1],
    ld: [-1, 1],
    rd: [1, 1],
  })[direction] || [-1, 0];

function draw(g, image, x = 0, y = 0, alpha = 1, w = g.W, h = g.H) {
  if (alpha <= 0) return;
  const { ctx } = g;
  ctx.globalAlpha = clamp(alpha);
  ctx.drawImage(image, x, y, w, h);
  ctx.globalAlpha = 1;
}
function black(g, alpha = 1, color = "#000") {
  const { ctx } = g;
  ctx.globalAlpha = clamp(alpha);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, g.W, g.H);
  ctx.globalAlpha = 1;
}
// Draws `image` only inside the path `trace` builds.
function clipped(g, image, trace, alpha = 1) {
  const { ctx } = g;
  ctx.save();
  ctx.beginPath();
  trace(ctx);
  ctx.clip();
  draw(g, image, 0, 0, alpha);
  ctx.restore();
}
// Draws `image` through a soft-edged mask: `paint(mask)` fills the mask
// canvas's opaque parts.
function masked(g, image, paint) {
  const m = g.scratch();
  const mc = m.getContext("2d");
  mc.globalCompositeOperation = "source-over";
  mc.clearRect(0, 0, g.W, g.H);
  paint(mc);
  mc.globalCompositeOperation = "source-in";
  mc.drawImage(image, 0, 0, g.W, g.H);
  mc.globalCompositeOperation = "source-over";
  g.ctx.drawImage(m, 0, 0);
}
// Fills a cells × rows mask where `on(i, j)` holds and stretches it over the
// slide without smoothing, so whole cells of `image` show.
function cells(g, image, cols, rows, on) {
  const grid = g.cellCanvas(cols, rows);
  const gc = grid.getContext("2d");
  const data = gc.createImageData(cols, rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      if (on(i, j)) data.data[(j * cols + i) * 4 + 3] = 255;
  gc.putImageData(data, 0, 0);
  masked(g, image, (mc) => {
    mc.imageSmoothingEnabled = false;
    mc.drawImage(grid, 0, 0, g.W, g.H);
    mc.imageSmoothingEnabled = true;
  });
}
// A linear soft edge moving along `dir` across the slide: the part already
// passed is opaque.
function sweep(mc, g, dir, f, soft) {
  const [vx, vy] = dir;
  const n = Math.hypot(vx, vy) || 1;
  const ux = vx / n,
    uy = vy / n;
  // The sweep starts at the corner or edge facing away from the motion.
  const sx = ux > 0 ? 0 : ux < 0 ? g.W : g.W / 2;
  const sy = uy > 0 ? 0 : uy < 0 ? g.H : g.H / 2;
  const length = Math.abs(ux) * g.W + Math.abs(uy) * g.H;
  const start = ux && uy ? [ux > 0 ? 0 : g.W, uy > 0 ? 0 : g.H] : [sx, sy];
  const front = f * (length + soft);
  const gradient = mc.createLinearGradient(
    start[0],
    start[1],
    start[0] + ux * length,
    start[1] + uy * length,
  );
  const alphaAt = (d) => clamp((front - d) / soft);
  const stops = new Set([0, 1]);
  for (const d of [front - soft, front])
    if (d > 0 && d < length) stops.add(d / length);
  for (const s of [...stops].sort((a, b) => a - b))
    gradient.addColorStop(s, `rgba(0,0,0,${alphaAt(s * length)})`);
  mc.fillStyle = gradient;
  mc.fillRect(0, 0, g.W, g.H);
}

// Fills the mask with a horizontal (or vertical) alpha profile, exact at the
// given key positions and linear between them.
function profile(mc, g, horizontal, size, alpha, keys) {
  const gradient = horizontal
    ? mc.createLinearGradient(0, 0, g.W, 0)
    : mc.createLinearGradient(0, 0, 0, g.H);
  const points = [
    ...new Set([0, size, ...keys.filter((k) => k > 0 && k < size)]),
  ].sort((a, b) => a - b);
  for (const d of points)
    gradient.addColorStop(d / size, `rgba(0,0,0,${alpha(d)})`);
  mc.fillStyle = gradient;
  mc.fillRect(0, 0, g.W, g.H);
}

function polygon(ctx, cx, cy, r, sides, rotation = 0) {
  for (let i = 0; i <= sides; i++) {
    const a = rotation + (i * Math.PI * 2) / sides;
    const x = cx + r * Math.cos(a),
      y = cy + r * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
}

const sideOffset = (g, dir, amount) => {
  const [vx, vy] = vector(dir);
  return [vx * amount * g.W, vy * amount * g.H];
};

export const EFFECTS_2D = {
  none(g) {
    draw(g, g.B);
  },
  fade(g) {
    const { q, o } = g;
    if (o.thruBlack) {
      black(g);
      if (q < 0.5) draw(g, g.A, 0, 0, 1 - smooth(q * 2));
      else draw(g, g.B, 0, 0, smooth(q * 2 - 1));
      return;
    }
    draw(g, g.A);
    draw(g, g.B, 0, 0, smooth(q));
  },
  cut(g) {
    const { q, o } = g;
    if (o.thruBlack && q > 0.2 && q < 0.8) black(g);
    else draw(g, q < 0.5 ? g.A : g.B);
  },
  push(g) {
    const e = easeInOut(g.q);
    const [ax, ay] = sideOffset(g, g.o.direction, e);
    const [bx, by] = sideOffset(g, g.o.direction, e - 1);
    black(g);
    draw(g, g.A, ax, ay);
    draw(g, g.B, bx, by);
  },
  pull(g) {
    const e = easeInOut(g.q);
    const [ax, ay] = sideOffset(g, g.o.direction, e);
    draw(g, g.B);
    // A soft shadow trails the slide being drawn away.
    g.ctx.save();
    g.ctx.shadowColor = "rgba(0,0,0,0.45)";
    g.ctx.shadowBlur = g.H * 0.03;
    draw(g, g.A, ax, ay);
    g.ctx.restore();
  },
  cover(g) {
    const e = easeInOut(g.q);
    const [bx, by] = sideOffset(g, g.o.direction, e - 1);
    draw(g, g.A);
    g.ctx.save();
    g.ctx.shadowColor = "rgba(0,0,0,0.45)";
    g.ctx.shadowBlur = g.H * 0.03;
    draw(g, g.B, bx, by);
    g.ctx.restore();
  },
  wipe(g) {
    draw(g, g.A);
    masked(g, g.B, (mc) =>
      sweep(mc, g, vector(g.o.direction), easeInOut(g.q), g.W * 0.12),
    );
  },
  strips(g) {
    draw(g, g.A);
    masked(g, g.B, (mc) =>
      sweep(mc, g, vector(g.o.direction), easeInOut(g.q), g.W * 0.16),
    );
  },
  split(g) {
    const { o } = g;
    const e = easeInOut(g.q);
    const vertical = o.orientation === "vert";
    const size = vertical ? g.W : g.H;
    const half = (o.direction === "out" ? e : 1 - e) * (size / 2);
    const soft = size * 0.04;
    const band = (mc) => {
      const c = size / 2;
      const alpha = (d) => clamp((half - Math.abs(d - c)) / soft + 0.5);
      profile(mc, g, vertical, size, alpha, [
        c - half - soft / 2,
        c - half + soft / 2,
        c,
        c + half - soft / 2,
        c + half + soft / 2,
      ]);
    };
    if (o.direction === "out") {
      draw(g, g.A);
      masked(g, g.B, band);
    } else {
      draw(g, g.B);
      masked(g, g.A, band);
    }
  },
  reveal(g) {
    const { q, o } = g;
    const dir = o.direction === "r" ? 1 : -1;
    black(g);
    if (o.thruBlack) {
      if (q < 0.5) {
        const e = easeIn(q * 2);
        draw(g, g.A, dir * e * g.W * 0.12, 0, 1 - e);
      } else {
        const e = easeOut(q * 2 - 1);
        draw(g, g.B, -dir * (1 - e) * g.W * 0.08, 0, e);
      }
      return;
    }
    const e = smooth(q);
    draw(g, g.B, -dir * (1 - e) * g.W * 0.08, 0, clamp(e * 1.4 - 0.2));
    draw(g, g.A, dir * easeIn(q) * g.W * 0.2, 0, 1 - clamp(q * 1.6));
  },
  randomBar(g) {
    const n = 96;
    const vertical = g.o.direction === "vert";
    const order = g.order(n);
    const shown = g.q * n;
    draw(g, g.A);
    cells(
      g,
      g.B,
      vertical ? n : 1,
      vertical ? 1 : n,
      (i, j) => order[vertical ? i : j] < shown,
    );
  },
  circle(g) {
    shapeReveal(g, (ctx, r) =>
      ctx.arc(g.W / 2, g.H / 2, Math.max(0, r), 0, Math.PI * 2),
    );
  },
  diamond(g) {
    shapeReveal(g, (ctx, r) => polygon(ctx, g.W / 2, g.H / 2, r * 1.42, 4));
  },
  plus(g) {
    shapeReveal(g, (ctx, r) => {
      const cx = g.W / 2,
        cy = g.H / 2,
        arm = r * 1.4,
        w = r * 0.55;
      ctx.rect(cx - w, cy - arm, w * 2, arm * 2);
      ctx.rect(cx - arm, cy - w, arm * 2, w * 2);
    });
  },
  zoom(g) {
    // The base effect's "box": a rectangle grows out of the middle or closes
    // in from the edges.
    const e = easeInOut(g.q);
    const box = (ctx, s) => {
      const w = (g.W * s) / 2,
        h = (g.H * s) / 2;
      ctx.rect(g.W / 2 - w, g.H / 2 - h, w * 2, h * 2);
    };
    if (g.o.direction === "in") {
      draw(g, g.B);
      // The slide leaving shrinks into the middle.
      clipped(g, g.A, (ctx) => box(ctx, 1 - e));
    } else {
      draw(g, g.A);
      clipped(g, g.B, (ctx) => box(ctx, e));
    }
  },
  flash(g) {
    const { q } = g;
    const peak = 0.38;
    if (q < peak) {
      draw(g, g.A);
      black(g, easeIn(q / peak), "#fff");
    } else {
      draw(g, g.B);
      black(g, Math.pow(1 - (q - peak) / (1 - peak), 1.6), "#fff");
    }
  },
  dissolve(g) {
    const cols = 64,
      rows = Math.max(1, Math.round((64 * g.H) / g.W));
    const order = g.order(cols * rows);
    const shown = g.q * cols * rows;
    draw(g, g.A);
    cells(g, g.B, cols, rows, (i, j) => order[j * cols + i] < shown);
  },
  wheel(g) {
    clockReveal(g, (g.o.spokes || 4) | 0 || 1, 1);
  },
  wheelReverse(g) {
    clockReveal(g, (g.o.spokes || 4) | 0 || 1, -1);
  },
  wedge(g) {
    const e = easeInOut(g.q);
    const r = Math.hypot(g.W, g.H);
    draw(g, g.A);
    clipped(g, g.B, (ctx) => {
      const top = -Math.PI / 2;
      ctx.moveTo(g.W / 2, g.H / 2);
      ctx.arc(g.W / 2, g.H / 2, r, top - e * Math.PI, top + e * Math.PI);
      ctx.closePath();
    });
  },
  comb(g) {
    const e = easeInOut(g.q);
    const n = 10;
    const vertical = g.o.direction === "vert";
    draw(g, g.B);
    const { ctx } = g;
    for (let i = 0; i < n; i++) {
      const sign = i % 2 ? 1 : -1;
      if (vertical) {
        const w = g.W / n,
          x = i * w;
        ctx.drawImage(g.A, x, 0, w, g.H, x, sign * e * g.H, w, g.H);
      } else {
        const h = g.H / n,
          y = i * h;
        ctx.drawImage(g.A, 0, y, g.W, h, sign * e * g.W, y, g.W, h);
      }
    }
  },
  newsflash(g) {
    const e = easeOut(g.q);
    const { ctx } = g;
    draw(g, g.A);
    black(g, g.q * 0.6);
    ctx.save();
    ctx.translate(g.W / 2, g.H / 2);
    ctx.rotate((1 - e) * Math.PI * 4);
    ctx.scale(Math.max(0.001, e), Math.max(0.001, e));
    ctx.drawImage(g.B, -g.W / 2, -g.H / 2, g.W, g.H);
    ctx.restore();
  },
  warp(g) {
    const e = easeInOut(g.q);
    const zoomed = (image, scale, alpha) => {
      const w = g.W * scale,
        h = g.H * scale;
      draw(g, image, (g.W - w) / 2, (g.H - h) / 2, alpha, w, h);
    };
    black(g);
    if (g.o.direction === "in") {
      zoomed(g.B, 0.4 + 0.6 * e, smooth(clamp(g.q * 1.6 - 0.3)));
      zoomed(g.A, 1 + 2.5 * easeIn(g.q), 1 - smooth(clamp(g.q * 1.6)));
    } else {
      zoomed(g.A, 1 - 0.6 * e, 1 - smooth(clamp(g.q * 1.6 - 0.3)));
      zoomed(g.B, 3.5 - 2.5 * easeOut(g.q), smooth(clamp(g.q * 1.6)));
    }
  },
  honeycomb(g) {
    const { ctx, q } = g;
    const r = g.H / 6.5;
    const w = Math.sqrt(3) * r;
    // The leaving slide turns and drifts forward while cells open over it.
    const spin = easeInOut(clamp(q * 1.4)) * 0.18;
    const scale = 1 + 0.35 * easeIn(clamp(q * 1.2));
    black(g);
    ctx.save();
    ctx.translate(g.W / 2, g.H / 2);
    ctx.rotate(spin);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 1 - clamp((q - 0.55) * 2.2);
    ctx.drawImage(g.A, -g.W / 2, -g.H / 2, g.W, g.H);
    ctx.restore();
    ctx.globalAlpha = 1;
    const centers = [];
    let n = 0;
    for (let row = -1; row * 1.5 * r < g.H + r * 2; row++)
      for (let col = -1; col * w < g.W + w; col++) {
        const x = col * w + (row % 2 ? w / 2 : 0),
          y = row * 1.5 * r;
        const d = Math.hypot(x - g.W / 2, y - g.H / 2) / Math.hypot(g.W, g.H);
        const start = 0.15 + d * 0.5 + g.random(n++) * 0.2;
        centers.push([x, y, local(q, start, 0.25)]);
      }
    const path = (ctx, grow) => {
      for (const [x, y, p] of centers)
        if (p > 0) polygon(ctx, x, y, r * grow(p), 6, Math.PI / 6);
    };
    // Dark cells appear first; the arriving slide fills them as they settle.
    ctx.save();
    ctx.beginPath();
    path(ctx, (p) => Math.min(1.02, p * 1.6));
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fill();
    ctx.restore();
    clipped(g, g.B, (ctx) => path(ctx, (p) => Math.max(0, p * 1.15 - 0.15)));
  },
  glitter(g) {
    const { ctx, q, o } = g;
    const hex = o.pattern === "hexagon";
    const cols = 22;
    const size = g.W / cols;
    const rows = Math.ceil(g.H / (size * (hex ? 0.86 : 1))) + 1;
    const [vx, vy] = vector(o.direction);
    draw(g, g.A);
    let n = 0;
    for (let j = -1; j < rows; j++)
      for (let i = -1; i <= cols; i++) {
        const x = (i + 0.5 + (hex && j % 2 ? 0.5 : 0)) * size;
        const y = (j + 0.5) * size * (hex ? 0.86 : 1);
        const along =
          (vx > 0 ? x / g.W : vx < 0 ? 1 - x / g.W : 0) +
          (vy > 0 ? y / g.H : vy < 0 ? 1 - y / g.H : 0);
        const p = local(q, along * 0.55 + g.random(n++) * 0.2, 0.25);
        if (p <= 0) continue;
        const flip = Math.abs(Math.cos(p * Math.PI));
        const image = p < 0.5 ? g.A : g.B;
        ctx.save();
        ctx.beginPath();
        if (hex) polygon(ctx, x, y, size * 0.58, 6, Math.PI / 6);
        else polygon(ctx, x, y, size * 0.72, 4);
        ctx.clip();
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.translate(x, y);
        ctx.scale(Math.max(0.02, flip), 1);
        ctx.translate(-x, -y);
        ctx.drawImage(image, 0, 0, g.W, g.H);
        ctx.fillStyle = `rgba(255,255,255,${Math.sin(p * Math.PI) * 0.7})`;
        ctx.fill();
        ctx.restore();
      }
  },
  vortex(g) {
    const { ctx, q, o } = g;
    const cols = 18,
      rows = Math.max(4, Math.round((cols * g.H) / g.W));
    const tw = g.W / cols,
      th = g.H / rows;
    const [vx, vy] = vector(o.direction);
    black(g);
    const half = q < 0.5;
    const image = half ? g.A : g.B;
    const p = half ? q * 2 : 2 - q * 2; // 0 → tiles in place, 1 → swirled
    let n = 0;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const cx = (i + 0.5) * tw,
          cy = (j + 0.5) * th;
        // Tiles nearest the leading side swirl away first.
        const lead =
          (vx > 0 ? 1 - cx / g.W : vx < 0 ? cx / g.W : 0.5) *
            Math.abs(vx || 0) +
          (vy > 0 ? 1 - cy / g.H : vy < 0 ? cy / g.H : 0.5) * Math.abs(vy || 0);
        const t = easeIn(local(p, lead * 0.45 + g.random(n++) * 0.15, 0.4));
        if (t >= 1) continue;
        const angle = t * (2.4 + g.random(n + 999)) * (vx || vy || 1);
        const dx = cx - g.W / 2,
          dy = cy - g.H / 2;
        const spin = Math.atan2(dy, dx) + angle;
        const dist = Math.hypot(dx, dy) * (1 + t * 0.6) + t * g.W * 0.15;
        const scale = 1 - t * 0.85;
        ctx.save();
        ctx.globalAlpha = 1 - t * t;
        ctx.translate(
          g.W / 2 + Math.cos(spin) * dist + vx * t * g.W * 0.3,
          g.H / 2 + Math.sin(spin) * dist + vy * t * g.H * 0.3,
        );
        ctx.rotate(angle * 1.5);
        ctx.scale(scale, scale);
        ctx.drawImage(
          image,
          i * tw,
          j * th,
          tw,
          th,
          -tw / 2,
          -th / 2,
          tw + 1,
          th + 1,
        );
        ctx.restore();
      }
    ctx.globalAlpha = 1;
  },
  shred(g) {
    const { ctx, q, o } = g;
    black(g);
    const half = q < 0.5;
    const image = half ? g.A : g.B;
    const p = half ? easeIn(q * 2) : easeIn(2 - q * 2);
    if (o.pattern === "rectangle") {
      const cols = 24,
        rows = Math.max(4, Math.round((cols * g.H) / g.W));
      const tw = g.W / cols,
        th = g.H / rows;
      let n = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const r1 = g.random(n++),
            r2 = g.random(n++);
          const t = clamp(p * 1.3 - r1 * 0.3);
          const outward = o.direction === "out" ? 1 : -1;
          const dx = (i + 0.5 - cols / 2) * tw * t * 1.5 * outward,
            dy = (j + 0.5 - rows / 2) * th * t * 1.5 * outward;
          const scale = o.direction === "out" ? 1 + t * 1.5 : 1 - t * 0.9;
          ctx.save();
          ctx.globalAlpha = 1 - t;
          ctx.translate(
            (i + 0.5) * tw + dx,
            (j + 0.5) * th + dy + t * t * g.H * 0.2,
          );
          ctx.rotate((r2 - 0.5) * t * 4);
          ctx.scale(scale, scale);
          ctx.drawImage(
            image,
            i * tw,
            j * th,
            tw,
            th,
            -tw / 2,
            -th / 2,
            tw + 1,
            th + 1,
          );
          ctx.restore();
        }
      ctx.globalAlpha = 1;
      return;
    }
    const n = 22;
    const sw = g.W / n;
    for (let i = 0; i < n; i++) {
      const lag = g.random(i) * 0.25;
      const t = clamp(p * 1.25 - lag);
      const sign = i % 2 ? 1 : -1;
      if (o.direction === "out") {
        const scale = 1 + t * 0.8;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.translate((i + 0.5) * sw, g.H / 2 + sign * t * g.H * 0.3);
        ctx.scale(scale, scale);
        ctx.drawImage(
          image,
          i * sw,
          0,
          sw,
          g.H,
          -sw / 2,
          -g.H / 2,
          sw + 1,
          g.H,
        );
        ctx.restore();
      } else
        ctx.drawImage(
          image,
          i * sw,
          0,
          sw,
          g.H,
          i * sw,
          sign * t * g.H * 1.05,
          sw + 1,
          g.H,
        );
    }
    ctx.globalAlpha = 1;
  },
  checker(g) {
    // Flat stand-in for the turning squares, used without WebGL.
    const cols = 12,
      rows = Math.max(3, Math.round((12 * g.H) / g.W));
    const across = g.o.direction !== "vert";
    draw(g, g.A);
    cells(g, g.B, cols, rows, (i, j) => {
      const at = across ? i / cols : j / rows;
      return g.q > at * 0.7 + ((i + j) % 2) * 0.15;
    });
  },
  blinds(g) {
    const n = 12;
    const vertical = g.o.direction === "vert";
    draw(g, g.A);
    const e = easeInOut(g.q);
    clipped(g, g.B, (ctx) => {
      for (let i = 0; i < n; i++) {
        if (vertical) {
          const w = g.W / n;
          ctx.rect(i * w + (w * (1 - e)) / 2, 0, w * e, g.H);
        } else {
          const h = g.H / n;
          ctx.rect(0, i * h + (h * (1 - e)) / 2, g.W, h * e);
        }
      }
    });
  },
  // Dynamic content: the backgrounds cross-fade while the content moves.
  pan(g) {
    const e = easeInOut(g.q);
    const L = g.layers;
    backgrounds(g);
    const [ax, ay] = sideOffset(g, g.o.direction, e);
    const [bx, by] = sideOffset(g, g.o.direction, e - 1);
    draw(g, L ? L.A.fg : g.A, ax, ay);
    draw(g, L ? L.B.fg : g.B, bx, by);
  },
  ferris(g) {
    const { ctx } = g;
    const L = g.layers;
    const sign = g.o.direction === "r" ? 1 : -1;
    backgrounds(g);
    // Content rides a large wheel whose hub sits far below the slide.
    const hubX = g.W / 2,
      hubY = g.H * 3.2;
    const swing = 0.5;
    const ride = (image, angle, alpha) => {
      ctx.save();
      ctx.globalAlpha = clamp(alpha);
      ctx.translate(hubX, hubY);
      ctx.rotate(angle);
      ctx.translate(-hubX, -hubY);
      const s = 1 - Math.min(0.35, Math.abs(angle) * 0.5);
      ctx.translate(g.W / 2, g.H / 2);
      ctx.scale(s, s);
      ctx.drawImage(image, -g.W / 2, -g.H / 2, g.W, g.H);
      ctx.restore();
    };
    const e = easeInOut(g.q);
    ride(L ? L.A.fg : g.A, sign * e * swing, 1 - easeIn(g.q));
    ride(L ? L.B.fg : g.B, -sign * (1 - e) * swing, easeOut(g.q));
  },
  flythrough(g) {
    const L = g.layers;
    const { q, o } = g;
    backgrounds(g);
    const bounce = (t) =>
      o.hasBounce
        ? 1 - Math.cos(t * Math.PI * 2.5) * Math.pow(1 - t, 2.2)
        : easeOut(t);
    const zoomed = (image, scale, alpha) => {
      const w = g.W * scale,
        h = g.H * scale;
      draw(g, image, (g.W - w) / 2, (g.H - h) / 2, alpha, w, h);
    };
    const outward = o.direction === "out";
    const t = clamp(q * 1.4 - 0.4);
    if (!outward) {
      zoomed(
        L ? L.A.fg : g.A,
        1 + 2.5 * easeIn(clamp(q * 1.5)),
        1 - clamp(q * 1.6),
      );
      zoomed(L ? L.B.fg : g.B, 0.2 + 0.8 * bounce(t), smooth(clamp(t * 2)));
    } else {
      zoomed(
        L ? L.A.fg : g.A,
        1 - 0.8 * easeIn(clamp(q * 1.5)),
        1 - clamp(q * 1.6),
      );
      zoomed(L ? L.B.fg : g.B, 3 - 2 * bounce(t), smooth(clamp(t * 2)));
    }
  },
};

function backgrounds(g) {
  const L = g.layers;
  black(g);
  if (!L) return;
  draw(g, L.A.bg);
  draw(g, L.B.bg, 0, 0, smooth(g.q));
}

function shapeReveal(g, trace) {
  const e = easeInOut(g.q);
  const r = Math.hypot(g.W, g.H) / 2;
  draw(g, g.A);
  clipped(g, g.B, (ctx) => trace(ctx, e * r));
}

function clockReveal(g, spokes, sense) {
  const e = easeInOut(g.q);
  const r = Math.hypot(g.W, g.H);
  draw(g, g.A);
  clipped(g, g.B, (ctx) => {
    const sweepAngle = (e * Math.PI * 2) / spokes;
    for (let i = 0; i < spokes; i++) {
      const start = -Math.PI / 2 + (sense * i * Math.PI * 2) / spokes;
      ctx.moveTo(g.W / 2, g.H / 2);
      ctx.arc(
        g.W / 2,
        g.H / 2,
        r,
        start,
        start + sense * sweepAngle,
        sense < 0,
      );
      ctx.closePath();
    }
  });
}
