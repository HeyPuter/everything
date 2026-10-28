/**
 * Dark page: the page drawn on screen as dark paper with light ink, for the dark appearance's "Dark page"
 * preference. Nothing in the document changes and nothing is laid out again: a page's context, while its
 * paint is dark, turns every color it is given (fills, strokes, shadows and gradient stops) as an inverted
 * page would show it, white paper to near-black and black ink to near-white, keeping hues; pictures and
 * other drawn bitmaps are left as they are, as a dark reading mode leaves photographs. Printing, PDF and
 * the saved file paint on their own canvases, which are never dark.
 */

// How far colors are turned: white paper becomes #1C1C1C and black ink #E3E3E3, about 13:1.
const AMOUNT = 0.89;
const DARK = Symbol('dark page');
const STATE = Symbol('dark page state');
const COLOR_PROPERTIES = ['fillStyle', 'strokeStyle', 'shadowColor'];
const GRADIENTS = ['createLinearGradient', 'createRadialGradient', 'createConicGradient'];

/** One channel inverted by AMOUNT, then the color turned half way round the hue circle, as the CSS filters
 * invert(0.89) hue-rotate(180deg) do: grays and the lightness of colors flip, red stays red. */
export function darkPageRgb([r, g, b]) {
  const inv = c => c * (1 - AMOUNT) + (255 - c) * AMOUNT;
  const [ir, ig, ib] = [inv(r), inv(g), inv(b)];
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(-0.574 * ir + 1.43 * ig + 0.144 * ib),
    clamp(0.426 * ir + 0.43 * ig + 0.144 * ib),
    clamp(0.426 * ir + 1.43 * ig - 0.856 * ib),
  ];
}

const hex = n => n.toString(16).padStart(2, '0');
/** A canvas color string as a dark page shows it. Colors the canvas cannot read pass through unchanged. */
export function darkPageColor(value, parse = parseColor) {
  const rgba = parse(value);
  if (!rgba) return value;
  const [r, g, b] = darkPageRgb(rgba);
  return rgba[3] >= 1 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r}, ${g}, ${b}, ${rgba[3]})`;
}

let scratch = null;
/** [r, g, b, alpha] for a CSS color, read through a canvas so every color syntax it takes is understood. */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  scratch ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!scratch) return null;
  // A value the canvas does not take leaves the color set before it, an unlikely one, in place.
  scratch.fillStyle = '#010203';
  scratch.fillStyle = value;
  const read = scratch.fillStyle;
  if (read === '#010203') return null;
  const short = /^#([0-9a-f]{6})$/i.exec(read);
  if (short) return [0, 2, 4].map(i => parseInt(short[1].slice(i, i + 2), 16)).concat(1);
  const long = /^rgba?\(([^)]+)\)$/i.exec(read);
  if (!long) return null;
  const parts = long[1].split(',').map(Number);
  return parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1] : null;
}

const turned = new Map();
function turn(value) {
  if (typeof value !== 'string') return value;
  let out = turned.get(value);
  if (out === undefined) { out = darkPageColor(value); if (turned.size > 4096) turned.clear(); turned.set(value, out); }
  return out;
}

/**
 * Whether this context paints dark from now on. The first time it is asked to, the context learns to turn its
 * colors: reading a color back gives the color as it was set, so code that saves and restores one is unaffected.
 */
export function setDarkPage(ctx, on) {
  if (!ctx || (!on && !ctx[STATE])) return;
  if (!ctx[STATE] && !install(ctx)) return;
  ctx[DARK] = !!on;
}

function install(ctx) {
  const proto = Object.getPrototypeOf(ctx);
  const descriptors = COLOR_PROPERTIES.map(name => [name, Object.getOwnPropertyDescriptor(proto, name)]);
  if (descriptors.some(([, d]) => !d?.set || !d?.get)) return false;
  const state = ctx[STATE] = { set: {}, stack: [] };
  for (const [name, d] of descriptors) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() { return Object.hasOwn(state.set, name) ? state.set[name] : d.get.call(this); },
      set(value) { state.set[name] = value; d.set.call(this, this[DARK] ? turn(value) : value); },
    });
  }
  const call = name => proto[name];
  const save = call('save'), restore = call('restore'), reset = call('reset');
  ctx.save = function () { state.stack.push({ ...state.set }); return save.call(this); };
  ctx.restore = function () { if (state.stack.length) state.set = state.stack.pop(); return restore.call(this); };
  if (reset) ctx.reset = function () { state.set = {}; state.stack = []; return reset.call(this); };
  for (const name of GRADIENTS) {
    const make = call(name);
    if (!make) continue;
    ctx[name] = function (...args) {
      const gradient = make.apply(this, args);
      if (this[DARK]) { const add = gradient.addColorStop; gradient.addColorStop = (offset, color) => add.call(gradient, offset, turn(color)); }
      return gradient;
    };
  }
  return true;
}
