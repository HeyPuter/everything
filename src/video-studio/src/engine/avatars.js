/**
 * Presenter avatars: eight original characters drawn with Canvas 2D in a
 * flat, softly shaded illustration style, at any size. A character is a
 * palette plus a hair style, an outfit and a few details (glasses, a beard,
 * earrings, freckles); drawAvatar() paints one in a pose from
 * engine/avatar-motion.js over an optional background.
 *
 * Drawing happens in "head units": the face is one unit wide with its
 * center at the origin, y pointing down. The framing decides how many units
 * fit the frame.
 */
import { hash01 } from './avatar-motion.js';

export const AVATAR_CHARACTERS = [
  {
    id: 'ava', label: 'Ava', hint: 'Warm and upbeat',
    skin: '#a86b4c', lips: '#8c4a40', iris: '#3b2418', hair: '#2a1a14', brows: '#1f130e', hairStyle: 'waves',
    outfit: { kind: 'blazer', main: '#d6a03f', inner: '#f4efe6' }, earrings: 'hoops', bg: '#34466b',
  },
  {
    id: 'leo', label: 'Leo', hint: 'Calm explainer',
    skin: '#efc6a6', lips: '#c4847a', iris: '#4c6d8e', hair: '#6b4a32', brows: '#563a26', hairStyle: 'sidepart',
    outfit: { kind: 'sweater', main: '#2c3e66', inner: '#ffffff' }, beard: 'stubble', bg: '#56786b',
  },
  {
    id: 'noor', label: 'Noor', hint: 'Clear and composed',
    skin: '#c99a72', lips: '#a25a52', iris: '#4a3020', hair: '#1d1512', brows: '#1d1512', hairStyle: 'bun',
    outfit: { kind: 'blouse', main: '#1f8a85', inner: '#1f8a85' }, earrings: 'studs', bg: '#6b4f6e',
  },
  {
    id: 'kofi', label: 'Kofi', hint: 'Friendly teacher',
    skin: '#6b4130', lips: '#5c3029', iris: '#2a1810', hair: '#141010', brows: '#141010', hairStyle: 'coils',
    outfit: { kind: 'overshirt', main: '#5f6b3a', inner: '#f2f2ee' }, glasses: 'round', bg: '#3c5a73',
  },
  {
    id: 'mei', label: 'Mei', hint: 'Bright and quick',
    skin: '#f2d2b6', lips: '#c97a7a', iris: '#2e2018', hair: '#16120f', brows: '#1d1814', hairStyle: 'bob',
    outfit: { kind: 'turtleneck', main: '#ece2d0', inner: '#ece2d0' }, bg: '#8a5a5a',
  },
  {
    id: 'ines', label: 'Ines', hint: 'Easygoing storyteller',
    skin: '#f5d4bf', lips: '#cf8276', iris: '#5a7a4a', hair: '#b5532a', brows: '#8c4022', hairStyle: 'ponytail',
    outfit: { kind: 'denim', main: '#4a6f9c', inner: '#4a6f9c' }, freckles: true, bg: '#36515a',
  },
  {
    id: 'raj', label: 'Raj', hint: 'Confident host',
    skin: '#9c6a4a', lips: '#7a4438', iris: '#2a1a12', hair: '#1a1412', brows: '#1a1412', hairStyle: 'quiff',
    outfit: { kind: 'blazer', main: '#3a3d44', inner: '#cfe0f2', collar: true }, beard: 'full', bg: '#5a4a3a',
  },
  {
    id: 'grace', label: 'Grace', hint: 'Seasoned and warm',
    skin: '#ecc3a3', lips: '#b56a6a', iris: '#5b6b7a', hair: '#d9d5d0', brows: '#9a9088', hairStyle: 'pixie',
    outfit: { kind: 'cardigan', main: '#7a2e3e', inner: '#f0e8dc' }, glasses: 'soft', earrings: 'pearls', bg: '#45606b',
  },
];

const BY_ID = new Map(AVATAR_CHARACTERS.map((c) => [c.id, c]));

export function avatarCharacter(id) {
  return BY_ID.get(id) || AVATAR_CHARACTERS[0];
}

/** A pose at rest (eyes open, mouth closed). */
export const REST_POSE = Object.freeze({ open: 0, wide: 0, round: 0, fric: 0, blink: 0, brow: 0, gazeX: 0, gazeY: 0, rot: 0, dx: 0, dy: 0, yaw: 0, breath: 0.5, hand: 0, handSide: 1 });

/* ---- Color helpers --------------------------------------------------------------- */

function rgbOf(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighter (amt > 0) or darker (amt < 0) version of a color. */
export function shade(hex, amt) {
  const [r, g, b] = rgbOf(hex);
  const t = amt < 0 ? 0 : 255;
  const k = Math.min(1, Math.abs(amt));
  const f = (v) => Math.round(v + (t - v) * k).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

function rgba(hex, a) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---- Stage ------------------------------------------------------------------------ */

/** Units visible per framing: top and bottom (y) and the width that must fit. */
const FRAMES = {
  head: { top: -1.3, bottom: 2.05, width: 3.5 },
  waist: { top: -1.2, bottom: 3.75, width: 4.0 },
  // Gallery tiles: just the head and a bit of the shoulders.
  close: { top: -1.05, bottom: 1.45, width: 2.4 },
};

/** Scale (pixels per unit) and origin of the face center in a w x h frame. */
export function avatarStage(w, h, framing = 'head') {
  const f = FRAMES[framing] || FRAMES.head;
  const u = Math.min(h / (f.bottom - f.top), w / f.width);
  return { u, ox: w / 2, oy: h - f.bottom * u };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---- Background ------------------------------------------------------------------- */

function drawBackground(ctx, w, h, look, seed) {
  if (look.background === 'none') return;
  const base = look.bgColor;
  if (look.background === 'color') {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.38, 0, w * 0.5, h * 0.38, Math.max(w, h) * 0.75);
    g.addColorStop(0, shade(base, 0.12));
    g.addColorStop(1, shade(base, -0.22));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  // Soft studio: an out-of-focus room in the chosen color, lit from one side.
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, shade(base, 0.18));
  wall.addColorStop(0.62, shade(base, -0.05));
  wall.addColorStop(1, shade(base, -0.38));
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.22, h * 0.3, 0, w * 0.22, h * 0.3, Math.max(w, h) * 0.55);
  glow.addColorStop(0, 'rgba(255,240,220,0.22)');
  glow.addColorStop(1, 'rgba(255,240,220,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  const m = Math.min(w, h);
  for (let i = 0; i < 11; i++) {
    const x = hash01(seed, 300 + i) * w;
    const y = (0.08 + hash01(seed, 400 + i) * 0.62) * h;
    const r = (0.035 + hash01(seed, 500 + i) * 0.09) * m;
    const warm = hash01(seed, 600 + i) < 0.6;
    const col = warm ? '255,226,180' : '200,225,255';
    const a = 0.08 + hash01(seed, 700 + i) * 0.14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(0.7, `rgba(${col},${a * 0.8})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A blurred shelf line low in the room.
  const shelf = ctx.createLinearGradient(0, h * 0.7, 0, h * 0.8);
  shelf.addColorStop(0, rgba(shade(base, -0.5), 0));
  shelf.addColorStop(0.5, rgba(shade(base, -0.5), 0.25));
  shelf.addColorStop(1, rgba(shade(base, -0.5), 0));
  ctx.fillStyle = shelf;
  ctx.fillRect(0, h * 0.7, w, h * 0.1);
}

/* ---- Body ------------------------------------------------------------------------- */

function torsoPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-0.24, 0.9);
  ctx.bezierCurveTo(-0.5, 1.0, -1.0, 0.98, -1.22, 1.2);
  ctx.bezierCurveTo(-1.44, 1.38, -1.5, 1.72, -1.52, 2.1);
  ctx.lineTo(-1.6, 4.4);
  ctx.lineTo(1.6, 4.4);
  ctx.lineTo(1.52, 2.1);
  ctx.bezierCurveTo(1.5, 1.72, 1.44, 1.38, 1.22, 1.2);
  ctx.bezierCurveTo(1.0, 0.98, 0.5, 1.0, 0.24, 0.9);
  // The neckline dips so the neck meets the clothes in a curve.
  ctx.quadraticCurveTo(0, 1.06, -0.24, 0.9);
  ctx.closePath();
}

function drawNeck(ctx, ch) {
  ctx.fillStyle = shade(ch.skin, -0.06);
  ctx.beginPath();
  ctx.moveTo(-0.2, 0.3);
  ctx.lineTo(0.2, 0.3);
  ctx.lineTo(0.23, 1.02);
  ctx.quadraticCurveTo(0, 1.12, -0.23, 1.02);
  ctx.closePath();
  ctx.fill();
  // Shadow under the jaw.
  const g = ctx.createLinearGradient(0, 0.45, 0, 0.82);
  g.addColorStop(0, rgba(shade(ch.skin, -0.45), 0.55));
  g.addColorStop(1, rgba(shade(ch.skin, -0.45), 0));
  ctx.fillStyle = g;
  ctx.fillRect(-0.24, 0.45, 0.48, 0.4);
}

function armCreases(ctx, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 1.16, 1.78);
    ctx.quadraticCurveTo(s * 1.1, 2.9, s * 1.2, 4.4);
    ctx.stroke();
  }
}

function drawOutfit(ctx, ch) {
  const o = ch.outfit;
  const main = o.main;
  const dark = shade(main, -0.28);
  // Inner layer first where it shows at the neck.
  if (o.kind === 'turtleneck') {
    ctx.fillStyle = shade(main, -0.04);
    ctx.beginPath();
    ctx.moveTo(-0.27, 0.52);
    ctx.lineTo(0.27, 0.52);
    ctx.lineTo(0.3, 1.05);
    ctx.lineTo(-0.3, 1.05);
    ctx.closePath();
    ctx.fill();
  }
  const g = ctx.createLinearGradient(-1.5, 1, 1.5, 3.5);
  g.addColorStop(0, shade(main, 0.08));
  g.addColorStop(1, shade(main, -0.12));
  ctx.fillStyle = g;
  torsoPath(ctx);
  ctx.fill();
  armCreases(ctx, rgba(dark, 0.7));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (o.kind) {
    case 'blazer': {
      // Shirt in the V, then lapels.
      ctx.fillStyle = o.inner;
      ctx.beginPath();
      ctx.moveTo(-0.34, 0.95);
      ctx.lineTo(0, 2.0);
      ctx.lineTo(0.34, 0.95);
      ctx.closePath();
      ctx.fill();
      if (o.collar) {
        ctx.fillStyle = shade(o.inner, -0.1);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * 0.24, 0.9);
          ctx.lineTo(s * 0.05, 1.18);
          ctx.lineTo(s * 0.34, 1.12);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.fillStyle = shade(ch.skin, -0.04);
        ctx.beginPath();
        ctx.moveTo(-0.24, 0.92);
        ctx.quadraticCurveTo(0, 1.24, 0.24, 0.92);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = dark;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.34, 0.93);
        ctx.lineTo(s * 0.62, 1.08);
        ctx.lineTo(s * 0.47, 1.4);
        ctx.lineTo(s * 0.6, 1.5);
        ctx.lineTo(s * 0.04, 2.08);
        ctx.lineTo(0, 2.0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = shade(main, -0.4);
      ctx.beginPath();
      ctx.arc(0.07, 2.55, 0.045, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0.07, 3.2, 0.045, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'sweater': {
      // Shirt collar points over a ribbed crew neck.
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(-0.34, 0.95);
      ctx.quadraticCurveTo(0, 1.24, 0.34, 0.95);
      ctx.stroke();
      ctx.fillStyle = o.inner;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.02, 1.1);
        ctx.lineTo(s * 0.24, 0.86);
        ctx.lineTo(s * 0.34, 1.04);
        ctx.lineTo(s * 0.12, 1.2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = rgba(dark, 0.5);
      ctx.lineWidth = 0.02;
      for (const y of [4.0, 4.08]) {
        ctx.beginPath();
        ctx.moveTo(-1.5, y);
        ctx.lineTo(1.5, y);
        ctx.stroke();
      }
      break;
    }
    case 'blouse': {
      ctx.fillStyle = shade(ch.skin, -0.04);
      ctx.beginPath();
      ctx.moveTo(-0.4, 0.95);
      ctx.bezierCurveTo(-0.3, 1.32, 0.3, 1.32, 0.4, 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.035;
      ctx.beginPath();
      ctx.moveTo(-0.4, 0.95);
      ctx.bezierCurveTo(-0.3, 1.32, 0.3, 1.32, 0.4, 0.95);
      ctx.stroke();
      // Soft gathers below the neckline.
      ctx.strokeStyle = rgba(dark, 0.45);
      ctx.lineWidth = 0.022;
      for (const x of [-0.18, 0, 0.18]) {
        ctx.beginPath();
        ctx.moveTo(x, 1.32);
        ctx.quadraticCurveTo(x * 1.3, 1.6, x * 1.1, 1.8);
        ctx.stroke();
      }
      break;
    }
    case 'overshirt': {
      ctx.fillStyle = o.inner;
      ctx.beginPath();
      ctx.moveTo(-0.3, 0.93);
      ctx.quadraticCurveTo(0, 1.12, 0.3, 0.93);
      ctx.lineTo(0.36, 4.4);
      ctx.lineTo(-0.36, 4.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(ch.skin, -0.04);
      ctx.beginPath();
      ctx.moveTo(-0.22, 0.92);
      ctx.quadraticCurveTo(0, 1.1, 0.22, 0.92);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = dark;
      for (const s of [-1, 1]) {
        // Collar flap and placket edge.
        ctx.beginPath();
        ctx.moveTo(s * 0.28, 0.9);
        ctx.lineTo(s * 0.62, 1.04);
        ctx.lineTo(s * 0.46, 1.36);
        ctx.lineTo(s * 0.34, 1.12);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(s > 0 ? 0.34 : -0.4, 1.2, 0.06, 3.2);
        // Chest pocket.
        ctx.strokeStyle = rgba(dark, 0.8);
        ctx.lineWidth = 0.025;
        roundRectPath(ctx, s * 0.82 - 0.2, 1.85, 0.4, 0.42, 0.04);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s * 0.82 - 0.2, 1.98);
        ctx.lineTo(s * 0.82 + 0.2, 1.98);
        ctx.stroke();
      }
      break;
    }
    case 'turtleneck': {
      ctx.strokeStyle = rgba(shade(main, -0.22), 0.7);
      ctx.lineWidth = 0.02;
      for (const y of [0.64, 0.76, 0.88]) {
        ctx.beginPath();
        ctx.moveTo(-0.27, y);
        ctx.quadraticCurveTo(0, y + 0.05, 0.27, y);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(shade(main, -0.25), 0.4);
      ctx.beginPath();
      ctx.moveTo(-0.3, 1.04);
      ctx.quadraticCurveTo(0, 1.16, 0.3, 1.04);
      ctx.stroke();
      break;
    }
    case 'denim': {
      ctx.fillStyle = shade(ch.skin, -0.04);
      ctx.beginPath();
      ctx.moveTo(-0.22, 0.92);
      ctx.lineTo(0, 1.32);
      ctx.lineTo(0.22, 0.92);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(main, -0.18);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.22, 0.88);
        ctx.lineTo(s * 0.02, 1.34);
        ctx.lineTo(s * 0.5, 1.12);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = shade(main, 0.35);
      ctx.setLineDash?.([0.05, 0.04]);
      ctx.lineWidth = 0.015;
      ctx.beginPath();
      ctx.moveTo(0.03, 1.34);
      ctx.lineTo(0.03, 4.4);
      ctx.stroke();
      for (const s of [-1, 1]) {
        roundRectPath(ctx, s * 0.78 - 0.22, 1.7, 0.44, 0.4, 0.05);
        ctx.stroke();
      }
      ctx.setLineDash?.([]);
      ctx.fillStyle = '#e8e4da';
      for (const y of [1.7, 2.35, 3.0, 3.65]) {
        ctx.beginPath();
        ctx.arc(-0.02, y, 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'cardigan': {
      ctx.fillStyle = o.inner;
      ctx.beginPath();
      ctx.moveTo(-0.42, 0.95);
      ctx.lineTo(-0.08, 2.5);
      ctx.lineTo(0.08, 2.5);
      ctx.lineTo(0.42, 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(ch.skin, -0.04);
      ctx.beginPath();
      ctx.moveTo(-0.26, 0.92);
      ctx.quadraticCurveTo(0, 1.18, 0.26, 0.92);
      ctx.closePath();
      ctx.fill();
      // Fine stripes on the top underneath.
      ctx.strokeStyle = rgba(shade(o.inner, -0.25), 0.6);
      ctx.lineWidth = 0.02;
      for (let y = 1.2; y < 2.5; y += 0.14) {
        const half = 0.42 - ((y - 0.95) / 1.55) * 0.34;
        ctx.beginPath();
        ctx.moveTo(-half, y);
        ctx.lineTo(half, y);
        ctx.stroke();
      }
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.07;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.42, 0.95);
        ctx.lineTo(s * 0.08, 2.5);
        ctx.lineTo(s * 0.08, 4.4);
        ctx.stroke();
      }
      ctx.fillStyle = shade(o.inner, -0.05);
      for (const y of [2.75, 3.3, 3.85]) {
        ctx.beginPath();
        ctx.arc(0.1, y, 0.04, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  // Shoulder highlight.
  const hl = ctx.createLinearGradient(0, 0.95, 0, 1.6);
  hl.addColorStop(0, 'rgba(255,255,255,0.08)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  torsoPath(ctx);
  ctx.fill();
}

/* ---- Hands ------------------------------------------------------------------------ */

function capsule(ctx, x0, y0, x1, y1, r) {
  ctx.lineWidth = r * 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** A forearm raised from the side by amount a (0 rest, below the frame; 1 up at the chest). */
function drawGestureArm(ctx, ch, side, a) {
  if (a <= 0.001) return;
  const s = side;
  const ex = s * 1.3;
  const ey = 2.85;
  const rx = s * 1.4;
  const ry = 4.3;
  const ux = s * 0.7;
  const uy = 2.0;
  const hx = rx + (ux - rx) * a;
  const hy = ry + (uy - ry) * a;
  const ang = Math.atan2(hy - ey, hx - ex);
  const wx = hx - Math.cos(ang) * 0.14;
  const wy = hy - Math.sin(ang) * 0.14;
  const sleeve = shade(ch.outfit.main, -0.04);
  ctx.strokeStyle = sleeve;
  capsule(ctx, ex, ey, wx, wy, 0.17);
  ctx.strokeStyle = rgba(shade(ch.outfit.main, -0.4), 0.9);
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  ctx.moveTo(ex - Math.sin(ang) * 0.17, ey + Math.cos(ang) * 0.17);
  ctx.lineTo(wx - Math.sin(ang) * 0.17, wy + Math.cos(ang) * 0.17);
  ctx.stroke();
  // Cuff.
  ctx.strokeStyle = shade(ch.outfit.main, -0.22);
  capsule(ctx, wx - Math.cos(ang) * 0.06, wy - Math.sin(ang) * 0.06, wx, wy, 0.175);
  // Hand: palm facing the viewer, fingers up and a little out.
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang + Math.PI / 2 - s * 0.25);
  ctx.scale(1.3, 1.3);
  const skin = ch.skin;
  ctx.fillStyle = skin;
  ctx.strokeStyle = skin;
  ctx.beginPath();
  ctx.ellipse(0, 0.02, 0.13, 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  const fingers = [[-0.085, 0.13], [-0.03, 0.16], [0.03, 0.155], [0.085, 0.125]];
  fingers.forEach(([x, len], i) => {
    const spread = (i - 1.5) * 0.06;
    capsule(ctx, x, -0.04, x + Math.sin(spread) * len, -0.04 - Math.cos(spread) * len, 0.03);
  });
  // Thumb on the inner side.
  const t = -s;
  capsule(ctx, t * 0.1, 0.06, t * 0.2, -0.04, 0.034);
  ctx.strokeStyle = rgba(shade(skin, -0.35), 0.5);
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(-0.07, 0.07);
  ctx.quadraticCurveTo(0, 0.1, 0.07, 0.05);
  ctx.stroke();
  ctx.restore();
}

/* ---- Head -------------------------------------------------------------------------- */

function facePath(ctx, jaw) {
  const cy = 0.68 + jaw;
  ctx.beginPath();
  ctx.moveTo(0, -0.66);
  ctx.bezierCurveTo(0.31, -0.66, 0.5, -0.47, 0.5, -0.18);
  ctx.bezierCurveTo(0.5, 0.1, 0.46, 0.33 + jaw * 0.4, 0.34, 0.5 + jaw * 0.6);
  ctx.bezierCurveTo(0.24, 0.62 + jaw, 0.12, cy, 0, cy);
  ctx.bezierCurveTo(-0.12, cy, -0.24, 0.62 + jaw, -0.34, 0.5 + jaw * 0.6);
  ctx.bezierCurveTo(-0.46, 0.33 + jaw * 0.4, -0.5, 0.1, -0.5, -0.18);
  ctx.bezierCurveTo(-0.5, -0.47, -0.31, -0.66, 0, -0.66);
  ctx.closePath();
}

function drawEars(ctx, ch, yaw) {
  for (const s of [-1, 1]) {
    const k = 1 - s * yaw * 0.25;
    ctx.fillStyle = shade(ch.skin, -0.05);
    ctx.beginPath();
    ctx.ellipse(s * (0.49 - yaw * 0.02), 0.03, 0.085 * k, 0.14, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(shade(ch.skin, -0.4), 0.5);
    ctx.lineWidth = 0.018;
    ctx.beginPath();
    ctx.ellipse(s * (0.5 - yaw * 0.02), 0.03, 0.04 * k, 0.08, s * 0.15, -Math.PI / 2, Math.PI / 2, s < 0);
    ctx.stroke();
  }
}

function drawEarrings(ctx, ch) {
  if (!ch.earrings) return;
  for (const s of [-1, 1]) {
    if (ch.earrings === 'hoops') {
      ctx.strokeStyle = '#e2b955';
      ctx.lineWidth = 0.022;
      ctx.beginPath();
      ctx.arc(s * 0.5, 0.25, 0.065, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = ch.earrings === 'pearls' ? '#f4efe6' : '#e2b955';
      ctx.beginPath();
      ctx.arc(s * 0.5, 0.15, 0.028, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawEye(ctx, ch, cx, cy, pose) {
  const ew = 0.085;
  const eh = 0.045;
  const top = cy - 2 * eh;
  const bot = cy + 1.6 * eh;
  const almond = () => {
    ctx.beginPath();
    ctx.moveTo(cx - ew, cy);
    ctx.quadraticCurveTo(cx, top, cx + ew, cy);
    ctx.quadraticCurveTo(cx, bot, cx - ew, cy);
    ctx.closePath();
  };
  ctx.save();
  almond();
  ctx.fillStyle = '#f7f4ef';
  ctx.fill();
  ctx.clip();
  const ix = cx + pose.gazeX * 0.035;
  const iy = cy + pose.gazeY * 0.025 - 0.004;
  ctx.fillStyle = ch.iris;
  ctx.beginPath();
  ctx.arc(ix, iy, 0.042, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#120c0a';
  ctx.beginPath();
  ctx.arc(ix, iy, 0.02, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(ix + 0.014, iy - 0.016, 0.011, 0, Math.PI * 2);
  ctx.fill();
  // Upper lid shadow on the eyeball.
  ctx.fillStyle = 'rgba(60,30,20,0.16)';
  ctx.fillRect(cx - ew, top, ew * 2, 0.035);
  // The lid comes down over the eye as it blinks.
  const b = Math.min(1, Math.max(0, pose.blink));
  const lidY = top + (bot - top) * b;
  if (b > 0.01) {
    ctx.fillStyle = shade(ch.skin, -0.06);
    ctx.beginPath();
    ctx.moveTo(cx - ew, cy);
    ctx.quadraticCurveTo(cx, top, cx + ew, cy);
    ctx.lineTo(cx + ew, cy);
    ctx.quadraticCurveTo(cx, lidY, cx - ew, cy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Lash line along the lid edge.
  ctx.strokeStyle = '#1c1210';
  ctx.lineWidth = 0.02;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - ew - 0.008, cy + 0.003);
  ctx.quadraticCurveTo(cx, b > 0.01 ? lidY : top, cx + ew + 0.008, cy - 0.004);
  ctx.stroke();
  // Crease above the eye.
  ctx.strokeStyle = rgba(shade(ch.skin, -0.4), 0.35);
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(cx - ew * 0.8, cy - 0.05);
  ctx.quadraticCurveTo(cx, cy - 0.11, cx + ew * 0.85, cy - 0.055);
  ctx.stroke();
}

function drawBrows(ctx, ch, pose, shift) {
  const raise = pose.brow * 0.045;
  ctx.strokeStyle = ch.brows;
  ctx.lineCap = 'round';
  ctx.lineWidth = ch.id === 'mei' || ch.id === 'noor' ? 0.03 : 0.038;
  for (const s of [-1, 1]) {
    const cx = s * 0.19 + shift;
    const by = -0.15 - raise;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.1, by + 0.02 + raise * 0.3);
    ctx.quadraticCurveTo(cx + s * 0.01, by - 0.035 - raise * 0.2, cx + s * 0.11, by + 0.012);
    ctx.stroke();
  }
}

function drawNose(ctx, ch, shift) {
  ctx.strokeStyle = rgba(shade(ch.skin, -0.42), 0.55);
  ctx.lineWidth = 0.02;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(shift - 0.015, 0.03);
  ctx.quadraticCurveTo(shift - 0.05, 0.16, shift - 0.035, 0.205);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(shift - 0.065, 0.2);
  ctx.quadraticCurveTo(shift, 0.245, shift + 0.065, 0.2);
  ctx.stroke();
  ctx.fillStyle = rgba(shade(ch.skin, 0.4), 0.35);
  ctx.beginPath();
  ctx.ellipse(shift + 0.008, 0.16, 0.02, 0.035, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Mouth from the pose's open, wide, round and fric values. */
function drawMouth(ctx, ch, pose, shift) {
  const o = Math.min(1, Math.max(0, pose.open));
  const w = pose.wide;
  const r = pose.round;
  const f = pose.fric;
  const my = 0.37 + o * 0.02;
  const half = 0.125 * (1 + 0.3 * w - 0.36 * r * (0.4 + o));
  let gap = o * 0.19 * (1 - 0.25 * w) + r * o * 0.05;
  if (f > 0.2) gap = Math.max(gap, 0.022 * f);
  const lip = ch.lips;
  const cornerY = my - 0.008 + w * 0.004;
  const upperTop = my - 0.045 - gap * 0.3;
  const openTop = my - gap * 0.35;
  const openBot = my + gap * 0.65;
  const lowerBot = openBot + 0.05 - r * 0.01;
  const x0 = shift - half;
  const x1 = shift + half;
  if (gap > 0.006) {
    // Inside of the mouth, teeth and tongue.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, cornerY);
    ctx.quadraticCurveTo(shift, openTop - gap * 0.3, x1, cornerY);
    ctx.quadraticCurveTo(shift, openBot + gap * 0.35, x0, cornerY);
    ctx.closePath();
    ctx.fillStyle = '#3a1a1c';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = '#f3efe8';
    ctx.fillRect(x0, openTop - gap, half * 2, gap * 0.45 + 0.012 + 0.02 * f);
    if (f > 0.3) ctx.fillRect(x0, openBot - 0.016 * f, half * 2, 0.03);
    if (o > 0.3) {
      ctx.fillStyle = '#b85a62';
      ctx.beginPath();
      ctx.ellipse(shift, openBot + 0.01, half * 0.6, gap * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // Upper lip with a soft bow.
  ctx.fillStyle = shade(lip, -0.05);
  ctx.beginPath();
  ctx.moveTo(x0, cornerY);
  ctx.bezierCurveTo(x0 + half * 0.4, upperTop + 0.004, shift - 0.04, upperTop - 0.004, shift, upperTop + 0.01);
  ctx.bezierCurveTo(shift + 0.04, upperTop - 0.004, x1 - half * 0.4, upperTop + 0.004, x1, cornerY);
  ctx.quadraticCurveTo(shift, openTop + (gap > 0.006 ? 0 : 0.012), x0, cornerY);
  ctx.closePath();
  ctx.fill();
  // Lower lip.
  ctx.fillStyle = lip;
  ctx.beginPath();
  ctx.moveTo(x0, cornerY);
  ctx.quadraticCurveTo(shift, gap > 0.006 ? openBot + gap * 0.05 : my + 0.004, x1, cornerY);
  ctx.quadraticCurveTo(shift, lowerBot + 0.02, x0, cornerY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.ellipse(shift, openBot + 0.025, half * 0.35, 0.01, 0, 0, Math.PI * 2);
  ctx.fill();
  if (gap <= 0.006) {
    ctx.strokeStyle = rgba(shade(lip, -0.5), 0.8);
    ctx.lineWidth = 0.012;
    ctx.beginPath();
    ctx.moveTo(x0, cornerY);
    ctx.quadraticCurveTo(shift, my + 0.006, x1, cornerY);
    ctx.stroke();
  }
}

function drawBeard(ctx, ch, jaw, kind) {
  const col = kind === 'full' ? ch.hair : shade(ch.hair, -0.1);
  ctx.save();
  facePath(ctx, jaw);
  ctx.clip();
  ctx.fillStyle = kind === 'full' ? col : rgba(col, 0.12);
  ctx.beginPath();
  ctx.moveTo(-0.52, -0.02);
  ctx.lineTo(-0.4, 0.2);
  ctx.quadraticCurveTo(-0.25, 0.3, -0.16, 0.3 + jaw * 0.2);
  ctx.quadraticCurveTo(0, 0.27, 0.16, 0.3 + jaw * 0.2);
  ctx.quadraticCurveTo(0.25, 0.3, 0.4, 0.2);
  ctx.lineTo(0.52, -0.02);
  ctx.lineTo(0.6, 1.0);
  ctx.lineTo(-0.6, 1.0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (kind === 'full') {
    // Fuller edge below the chin and a mustache.
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(0, 0.66 + jaw, 0.2, 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-0.15, 0.335);
    ctx.quadraticCurveTo(0, 0.25, 0.15, 0.335);
    ctx.quadraticCurveTo(0, 0.3, -0.15, 0.335);
    ctx.fill();
  }
}

function drawFreckles(ctx, ch, seed, shift) {
  ctx.fillStyle = rgba(shade(ch.skin, -0.35), 0.45);
  for (let i = 0; i < 22; i++) {
    const s = i % 2 ? 1 : -1;
    const x = shift + s * (0.08 + hash01(seed, 900 + i) * 0.24);
    const y = 0.08 + hash01(seed, 950 + i) * 0.16;
    ctx.beginPath();
    ctx.arc(x, y, 0.008 + hash01(seed, 990 + i) * 0.006, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGlasses(ctx, kind, shift) {
  ctx.strokeStyle = kind === 'soft' ? '#7a4a32' : '#1d1d1f';
  ctx.lineWidth = 0.022;
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (const s of [-1, 1]) {
    const cx = shift + s * 0.19;
    ctx.beginPath();
    if (kind === 'round') ctx.arc(cx, 0.0, 0.125, 0, Math.PI * 2);
    else roundRectPath(ctx, cx - 0.15, -0.09, 0.3, 0.2, 0.06);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + s * (kind === 'round' ? 0.125 : 0.15), -0.02);
    ctx.lineTo(s * 0.5, -0.04);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(shift - 0.065, -0.01);
  ctx.quadraticCurveTo(shift, -0.05, shift + 0.065, -0.01);
  ctx.stroke();
}

/* ---- Hair ---------------------------------------------------------------------------- */

function hairFill(ctx, ch) {
  const g = ctx.createLinearGradient(-0.5, -0.9, 0.5, 0.6);
  g.addColorStop(0, shade(ch.hair, 0.14));
  g.addColorStop(1, shade(ch.hair, -0.12));
  return g;
}

function strands(ctx, ch, lines) {
  ctx.strokeStyle = rgba(shade(ch.hair, ch.hair === '#d9d5d0' ? -0.25 : 0.3), 0.35);
  ctx.lineWidth = 0.014;
  ctx.lineCap = 'round';
  for (const [x0, y0, cx, cy, x1, y1] of lines) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }
}

/** Hair behind the head and shoulders. */
function drawBackHair(ctx, ch, pose) {
  ctx.fillStyle = hairFill(ctx, ch);
  switch (ch.hairStyle) {
    case 'waves': {
      ctx.beginPath();
      ctx.moveTo(-0.62, -0.25);
      ctx.bezierCurveTo(-0.66, -0.95, 0.66, -0.95, 0.62, -0.25);
      ctx.bezierCurveTo(0.7, 0.2, 0.62, 0.5, 0.74, 0.85);
      ctx.bezierCurveTo(0.84, 1.1, 0.7, 1.3, 0.8, 1.5);
      ctx.quadraticCurveTo(0.55, 1.62, 0.36, 1.45);
      ctx.lineTo(-0.36, 1.45);
      ctx.quadraticCurveTo(-0.55, 1.62, -0.8, 1.5);
      ctx.bezierCurveTo(-0.7, 1.3, -0.84, 1.1, -0.74, 0.85);
      ctx.bezierCurveTo(-0.62, 0.5, -0.7, 0.2, -0.62, -0.25);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'bob': {
      ctx.beginPath();
      ctx.moveTo(-0.6, -0.2);
      ctx.bezierCurveTo(-0.66, -0.95, 0.66, -0.95, 0.6, -0.2);
      ctx.bezierCurveTo(0.64, 0.15, 0.66, 0.42, 0.62, 0.6);
      ctx.quadraticCurveTo(0.5, 0.66, 0.36, 0.58);
      ctx.lineTo(-0.36, 0.58);
      ctx.quadraticCurveTo(-0.5, 0.66, -0.62, 0.6);
      ctx.bezierCurveTo(-0.66, 0.42, -0.64, 0.15, -0.6, -0.2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'bun': {
      ctx.beginPath();
      ctx.arc(0.04, -0.86, 0.22, 0, Math.PI * 2);
      ctx.fill();
      strands(ctx, ch, [[-0.12, -0.9, 0.04, -1.02, 0.18, -0.86], [-0.1, -0.78, 0.06, -0.72, 0.2, -0.8]]);
      break;
    }
    case 'ponytail': {
      // Swings a little against the head's motion.
      const sw = -pose.rot * 0.012;
      ctx.beginPath();
      ctx.moveTo(0.3, -0.62);
      ctx.bezierCurveTo(0.78 + sw, -0.5, 0.86 + sw, 0.3, 0.7 + sw * 1.6, 0.95);
      ctx.quadraticCurveTo(0.62 + sw * 1.6, 1.08, 0.55 + sw, 0.9);
      ctx.bezierCurveTo(0.62, 0.3, 0.52, -0.2, 0.3, -0.4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'pixie':
    case 'sidepart':
    case 'quiff': {
      ctx.beginPath();
      ctx.ellipse(0, -0.2, 0.56, 0.62, 0, Math.PI * 0.95, Math.PI * 2.05);
      ctx.fill();
      break;
    }
    default:
      break;
  }
}

/** Hair over the forehead and the top of the head. */
function drawFrontHair(ctx, ch, shift) {
  ctx.save();
  ctx.translate(shift * 0.4, 0);
  ctx.fillStyle = hairFill(ctx, ch);
  switch (ch.hairStyle) {
    case 'waves': {
      ctx.beginPath();
      ctx.moveTo(-0.6, 0.05);
      ctx.bezierCurveTo(-0.66, -0.55, -0.4, -0.92, 0.05, -0.9);
      ctx.bezierCurveTo(0.5, -0.88, 0.68, -0.55, 0.6, 0.05);
      ctx.bezierCurveTo(0.52, -0.2, 0.4, -0.34, 0.14, -0.5);
      ctx.bezierCurveTo(-0.05, -0.4, -0.3, -0.42, -0.5, -0.18);
      ctx.quadraticCurveTo(-0.55, -0.05, -0.6, 0.05);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[0.12, -0.84, -0.2, -0.7, -0.45, -0.22], [0.16, -0.8, 0.42, -0.6, 0.55, -0.1]]);
      break;
    }
    case 'sidepart': {
      ctx.beginPath();
      ctx.moveTo(-0.53, -0.08);
      ctx.bezierCurveTo(-0.6, -0.62, -0.32, -0.86, 0.02, -0.86);
      ctx.bezierCurveTo(0.4, -0.86, 0.6, -0.62, 0.53, -0.12);
      ctx.quadraticCurveTo(0.46, -0.36, 0.28, -0.46);
      ctx.bezierCurveTo(0.05, -0.56, -0.2, -0.5, -0.26, -0.56);
      ctx.quadraticCurveTo(-0.42, -0.4, -0.53, -0.08);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[-0.24, -0.6, 0.1, -0.78, 0.48, -0.42], [-0.2, -0.54, 0.08, -0.66, 0.42, -0.3]]);
      break;
    }
    case 'bun': {
      ctx.beginPath();
      ctx.moveTo(-0.52, -0.02);
      ctx.bezierCurveTo(-0.6, -0.6, -0.35, -0.8, 0, -0.8);
      ctx.bezierCurveTo(0.35, -0.8, 0.6, -0.6, 0.52, -0.02);
      ctx.bezierCurveTo(0.44, -0.3, 0.2, -0.46, 0, -0.5);
      ctx.bezierCurveTo(-0.2, -0.46, -0.44, -0.3, -0.52, -0.02);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[0, -0.5, -0.02, -0.66, 0, -0.8], [-0.1, -0.5, -0.35, -0.5, -0.46, -0.1], [0.1, -0.5, 0.35, -0.5, 0.46, -0.1]]);
      break;
    }
    case 'coils': {
      ctx.beginPath();
      ctx.moveTo(-0.52, -0.12);
      ctx.bezierCurveTo(-0.56, -0.66, -0.32, -0.84, 0, -0.84);
      ctx.bezierCurveTo(0.32, -0.84, 0.56, -0.66, 0.52, -0.12);
      ctx.quadraticCurveTo(0.45, -0.4, 0.3, -0.42);
      ctx.quadraticCurveTo(0, -0.47, -0.3, -0.42);
      ctx.quadraticCurveTo(-0.45, -0.4, -0.52, -0.12);
      ctx.closePath();
      ctx.fill();
      // Tight texture along the outline.
      ctx.fillStyle = shade(ch.hair, 0.12);
      for (let i = 0; i <= 18; i++) {
        const a = Math.PI * (1.08 + (i / 18) * 0.84);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 0.5, -0.36 + Math.sin(a) * 0.5, 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(shade(ch.hair, 0.3), 0.25);
      for (let i = 0; i < 16; i++) {
        const x = -0.38 + hash01(41, i) * 0.76;
        const y = -0.76 + hash01(43, i) * 0.26;
        ctx.beginPath();
        ctx.arc(x, y, 0.025, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'bob': {
      ctx.beginPath();
      ctx.moveTo(-0.6, 0.1);
      ctx.bezierCurveTo(-0.66, -0.62, -0.36, -0.9, 0, -0.9);
      ctx.bezierCurveTo(0.36, -0.9, 0.66, -0.62, 0.6, 0.1);
      ctx.quadraticCurveTo(0.54, -0.08, 0.46, -0.18);
      ctx.quadraticCurveTo(0, -0.24, -0.46, -0.18);
      ctx.quadraticCurveTo(-0.54, -0.08, -0.6, 0.1);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[-0.2, -0.3, -0.18, -0.25, -0.17, -0.2], [0.05, -0.3, 0.06, -0.25, 0.07, -0.21], [0.28, -0.3, 0.3, -0.25, 0.31, -0.2], [-0.3, -0.84, 0, -0.9, 0.3, -0.84]]);
      break;
    }
    case 'ponytail': {
      ctx.beginPath();
      ctx.moveTo(-0.52, -0.06);
      ctx.bezierCurveTo(-0.6, -0.62, -0.32, -0.84, 0.02, -0.84);
      ctx.bezierCurveTo(0.38, -0.84, 0.6, -0.6, 0.52, -0.06);
      ctx.quadraticCurveTo(0.44, -0.36, 0.2, -0.46);
      ctx.quadraticCurveTo(0.0, -0.5, -0.18, -0.44);
      ctx.quadraticCurveTo(-0.44, -0.36, -0.52, -0.06);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[-0.15, -0.46, 0.1, -0.7, 0.44, -0.62], [0.05, -0.47, 0.3, -0.58, 0.48, -0.42]]);
      break;
    }
    case 'quiff': {
      ctx.beginPath();
      ctx.moveTo(-0.52, -0.08);
      ctx.bezierCurveTo(-0.56, -0.6, -0.4, -0.82, -0.05, -0.9);
      ctx.bezierCurveTo(0.2, -1.0, 0.5, -0.86, 0.55, -0.55);
      ctx.quadraticCurveTo(0.58, -0.3, 0.52, -0.1);
      ctx.quadraticCurveTo(0.46, -0.38, 0.3, -0.48);
      ctx.quadraticCurveTo(0, -0.54, -0.3, -0.48);
      ctx.quadraticCurveTo(-0.46, -0.38, -0.52, -0.08);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[-0.3, -0.52, -0.05, -0.85, 0.35, -0.85], [-0.1, -0.5, 0.15, -0.78, 0.45, -0.62]]);
      break;
    }
    case 'pixie': {
      ctx.beginPath();
      ctx.moveTo(-0.55, 0.02);
      ctx.bezierCurveTo(-0.62, -0.6, -0.34, -0.88, 0.02, -0.88);
      ctx.bezierCurveTo(0.4, -0.88, 0.62, -0.6, 0.55, 0.02);
      ctx.quadraticCurveTo(0.5, -0.16, 0.42, -0.2);
      ctx.bezierCurveTo(0.2, -0.24, -0.1, -0.36, -0.3, -0.5);
      ctx.quadraticCurveTo(-0.46, -0.32, -0.55, 0.02);
      ctx.closePath();
      ctx.fill();
      strands(ctx, ch, [[-0.3, -0.5, 0.0, -0.4, 0.4, -0.22], [-0.2, -0.7, 0.1, -0.56, 0.48, -0.4], [-0.5, -0.4, -0.52, -0.2, -0.5, -0.02]]);
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/* ---- Whole character ---------------------------------------------------------------- */

/**
 * Paint an avatar into ctx over a w x h frame.
 *   look: { character, framing, background, bgColor, seed }
 *   pose: from avatarPose() (REST_POSE when omitted)
 *   radius: rounded frame corners in pixels (picture in picture)
 */
export function drawAvatar(ctx, w, h, look, pose = REST_POSE, { radius = 0 } = {}) {
  const ch = avatarCharacter(look.character);
  const seed = look.seed || 1;
  ctx.save();
  if (radius > 0 && look.background !== 'none') {
    roundRectPath(ctx, 0, 0, w, h, Math.min(radius, w / 2, h / 2));
    ctx.clip();
  }
  drawBackground(ctx, w, h, look, seed);
  const { u, ox, oy } = avatarStage(w, h, look.framing);
  ctx.translate(ox, oy);
  ctx.scale(u, u);
  if (look.background !== 'none') {
    // Soft shadow on the wall behind the shoulders.
    const g = ctx.createRadialGradient(0.15, 1.6, 0, 0.15, 1.6, 2.4);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-2.6, -0.8, 5.4, 5.4);
  }
  const jaw = Math.min(1, Math.max(0, pose.open)) * 0.035;
  const yaw = pose.yaw || 0;
  const shift = yaw * 0.045;
  const head = (fn) => {
    ctx.save();
    ctx.translate(pose.dx, pose.dy);
    ctx.translate(0, 0.62);
    ctx.rotate((pose.rot * Math.PI) / 180);
    ctx.translate(0, -0.62);
    fn();
    ctx.restore();
  };
  // Body, breathing.
  ctx.save();
  ctx.translate(pose.dx * 0.3, -0.012 * pose.breath);
  head(() => drawBackHair(ctx, ch, pose));
  drawNeck(ctx, ch);
  drawOutfit(ctx, ch);
  ctx.restore();
  head(() => {
    drawEars(ctx, ch, yaw);
    drawEarrings(ctx, ch);
    const g = ctx.createLinearGradient(-0.5, -0.6, 0.5, 0.7);
    g.addColorStop(0, shade(ch.skin, 0.08));
    g.addColorStop(1, shade(ch.skin, -0.08));
    ctx.fillStyle = g;
    facePath(ctx, jaw);
    ctx.fill();
    // Shade on the far side of a turned face, and the jaw.
    ctx.save();
    facePath(ctx, jaw);
    ctx.clip();
    const side = ctx.createLinearGradient(-0.5, 0, 0.5, 0);
    const a = 0.1 + Math.abs(yaw) * 0.08;
    side.addColorStop(0, rgba(shade(ch.skin, -0.5), yaw > 0 ? a : 0.05));
    side.addColorStop(0.35, rgba(shade(ch.skin, -0.5), 0));
    side.addColorStop(0.65, rgba(shade(ch.skin, -0.5), 0));
    side.addColorStop(1, rgba(shade(ch.skin, -0.5), yaw < 0 ? a : 0.05));
    ctx.fillStyle = side;
    ctx.fillRect(-0.6, -0.8, 1.2, 1.7);
    // Blush.
    for (const s of [-1, 1]) {
      const b = ctx.createRadialGradient(shift + s * 0.27, 0.22, 0, shift + s * 0.27, 0.22, 0.14);
      b.addColorStop(0, rgba(ch.lips, 0.22));
      b.addColorStop(1, rgba(ch.lips, 0));
      ctx.fillStyle = b;
      ctx.fillRect(shift + s * 0.27 - 0.15, 0.07, 0.3, 0.3);
    }
    ctx.restore();
    if (ch.beard) drawBeard(ctx, ch, jaw, ch.beard);
    if (ch.freckles) drawFreckles(ctx, ch, 77, shift);
    for (const s of [-1, 1]) drawEye(ctx, ch, shift + s * 0.19, 0, pose);
    drawBrows(ctx, ch, pose, shift);
    drawNose(ctx, ch, shift * 1.4);
    drawMouth(ctx, ch, pose, shift * 1.2);
    drawFrontHair(ctx, ch, shift);
    if (ch.glasses) drawGlasses(ctx, ch.glasses, shift);
  });
  if (look.framing === 'waist' && pose.hand > 0) drawGestureArm(ctx, ch, pose.handSide || 1, pose.hand);
  ctx.restore();
}
