/**
 * Thumbnails for text looks (presets, word-art effects, bubbles, letter
 * animations, templates), drawn by the real text renderer so a tile shows
 * exactly what the clip will look like. Animated previews run only while a
 * tile is hovered or focused.
 */
import { h } from '../lib/dom.js';
import { rasterizeText, fontString } from '../engine/text.js';
import { DEFAULT_TEXT_STYLE } from '../model/project.js';
import { TEXT_ANIMS } from '../engine/text-anim.js';

const BG = '#26262b';

function fit(g, r, w, hh, { k = null, maxScale = 1.2, margin = 0.86 } = {}) {
  const s = k ?? Math.min((w * margin) / r.width, (hh * margin) / r.height, maxScale);
  g.drawImage(r.canvas, (w - r.width * s) / 2, (hh - r.height * s) / 2, r.width * s, r.height * s);
  return s;
}

/** Draw a look { text, style } into a canvas. Returns the scale used (or null). */
export function drawLook(canvas, look, { bg = BG, anim = null, k = null, scale = 0.5, maxScale = 1.2, margin } = {}) {
  const g = canvas.getContext?.('2d');
  if (!g) return null;
  const w = canvas.width;
  const hh = canvas.height;
  g.clearRect(0, 0, w, hh);
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, hh);
  }
  try {
    const clip = { text: look.text ?? 'Text', style: { ...DEFAULT_TEXT_STYLE, ...look.style }, marks: look.marks };
    const r = rasterizeText(clip, 1, scale, false, { anim });
    return fit(g, r, w, hh, { k, maxScale: maxScale / scale, margin });
  } catch {
    return null; // no canvas text support (tests)
  }
}

/** Redraw once the look's font has loaded. */
function whenFontReady(style, fn) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const spec = fontString({ ...DEFAULT_TEXT_STYLE, ...style }, 32);
  if (document.fonts.check?.(spec)) return;
  document.fonts.load(spec).then(fn, () => {});
}

/** A canvas showing a look; className defaults to tile-canvas. */
export function lookCanvas(look, w = 192, hh = 108, opts = {}) {
  const c = h(`canvas.${opts.className || 'tile-canvas'}`, { width: w, height: hh, 'aria-hidden': 'true' });
  const draw = () => drawLook(c, look, opts);
  draw();
  whenFontReady(look.style || {}, draw);
  return c;
}

const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Play a letter animation in a canvas while the host element is hovered or
 * focused. kind: 'in' | 'out' | 'loop'. The still frame shows the end state
 * of an in animation (the text), the start of an out one.
 */
export function hoverAnimateLook(host, canvas, look, animId, kind, opts = {}) {
  if (!TEXT_ANIMS[animId] || prefersReducedMotion()) return;
  let raf = 0;
  let start = 0;
  let k = null;
  const period = kind === 'loop' ? 1.6 : 1.3;
  const frame = (now) => {
    // A tile replaced while hovered never gets pointerleave.
    if (!canvas.isConnected) {
      raf = 0;
      return;
    }
    if (!start) start = now;
    const t = ((now - start) / 1000) % (period + 0.4);
    const p = Math.min(1, t / period);
    const entry = { id: animId, phase: kind, p: kind === 'loop' ? (t / (period + 0.4)) : p };
    const used = drawLook(canvas, look, { ...opts, anim: [entry], k });
    k ??= used;
    raf = requestAnimationFrame(frame);
  };
  const on = () => {
    if (raf) return;
    start = 0;
    raf = requestAnimationFrame(frame);
  };
  const off = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    k = null;
    drawLook(canvas, look, opts);
  };
  host.addEventListener('pointerenter', on);
  host.addEventListener('pointerleave', off);
  host.addEventListener('focus', on);
  host.addEventListener('blur', off);
}
