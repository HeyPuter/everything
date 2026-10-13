/**
 * Thumbnail previews for effects, filters and transitions, rendered with the
 * real compositor onto a generated sample scene so each tile shows exactly
 * what the look does. One small offscreen GL context serves every tile.
 * Tiles render when they scroll into view, a few per frame, so opening a tab
 * with dozens of looks compiles only the shaders that are actually shown.
 */
import { Compositor } from '../../engine/compositor.js';
import { DEFAULT_ADJUST } from '../../model/project.js';
import { effectDefaults } from '../../model/effect-params.js';
import { isBodyEffect } from '../../model/body-effects.js';

/** Search: a look matches by its label or its category's label. */
export function matchesLook(item, q, categories = []) {
  if (!q) return true;
  const cat = categories.find((c) => c.id === item.cat)?.label || '';
  return item.label.toLowerCase().includes(q) || cat.toLowerCase().includes(q);
}

/** Params a tile shows an effect with: its defaults, with on/off strength turned up enough to read. */
function previewParams(id) {
  const p = effectDefaults(id);
  if (typeof p.strength === 'number') p.strength = Math.max(p.strength, 60);
  return p;
}

const effectLayer = (id, t) => ({ kind: 'effect', effect: id, params: previewParams(id), local: t * 1e6, duration: 2e6 });

/** Layers that show an effect: over the sample scene, or on the figure's own clip for body effects. */
const effectLayers = (id, t) => (isBodyEffect(id)
  ? [mediaLayer('p', { effects: [{ id, params: previewParams(id) }], fxTime: t * 1e6, fxDur: 2e6 })]
  : [mediaLayer('a'), effectLayer(id, t)]);

const W = 192;
const H = 108;
let shared = null;
const cache = new Map();
const stacks = new Map(); // key -> effect list, for 'stack' previews

function sampleScene(warm) {
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  const g = c.getContext('2d');
  if (!g) return c;
  const w = c.width;
  const hh = c.height;
  const sky = g.createLinearGradient(0, 0, 0, hh);
  sky.addColorStop(0, warm ? '#ff9a62' : '#4f8dd6');
  sky.addColorStop(0.6, warm ? '#ffd49a' : '#b6dcf5');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, hh);
  g.fillStyle = warm ? '#fff3c4' : '#ffffff';
  g.beginPath();
  g.arc(w * 0.72, hh * 0.34, hh * 0.13, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = warm ? '#7a3b4a' : '#2f6f5b';
  g.beginPath();
  g.moveTo(0, hh * 0.72);
  g.quadraticCurveTo(w * 0.25, hh * 0.48, w * 0.5, hh * 0.68);
  g.quadraticCurveTo(w * 0.75, hh * 0.86, w, hh * 0.6);
  g.lineTo(w, hh);
  g.lineTo(0, hh);
  g.fill();
  g.fillStyle = warm ? '#3c1f33' : '#1d4038';
  g.beginPath();
  g.moveTo(0, hh * 0.86);
  g.quadraticCurveTo(w * 0.4, hh * 0.7, w, hh * 0.9);
  g.lineTo(w, hh);
  g.lineTo(0, hh);
  g.fill();
  // A figure so motion effects read.
  g.fillStyle = warm ? '#2a1424' : '#14302a';
  g.beginPath();
  g.arc(w * 0.3, hh * 0.5, hh * 0.06, 0, Math.PI * 2);
  g.fill();
  g.fillRect(w * 0.285, hh * 0.56, w * 0.03, hh * 0.18);
  return c;
}

/** A standing figure, for body effect tiles: drawn in color on a scene, or white alone as its matte. */
function drawFigure(g, w, hh, fill) {
  const x = w * 0.5;
  g.fillStyle = fill.skin || fill;
  g.beginPath();
  g.ellipse(x, hh * 0.3, hh * 0.085, hh * 0.1, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(x - hh * 0.03, hh * 0.37, hh * 0.06, hh * 0.06);
  g.fillStyle = fill.shirt || fill;
  g.beginPath();
  g.moveTo(x - hh * 0.2, hh * 0.47);
  g.quadraticCurveTo(x, hh * 0.39, x + hh * 0.2, hh * 0.47);
  g.lineTo(x + hh * 0.24, hh);
  g.lineTo(x - hh * 0.24, hh);
  g.closePath();
  g.fill();
}

function personScene() {
  const c = sampleScene(false);
  const g = c.getContext('2d');
  if (g) drawFigure(g, c.width, c.height, { skin: '#d9a07a', shirt: '#e2513c' });
  return c;
}

function personMatte() {
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  const g = c.getContext('2d');
  if (g) drawFigure(g, c.width, c.height, '#ffffff');
  return c;
}

function engine() {
  if (shared !== null) return shared;
  try {
    const canvas = document.createElement('canvas');
    const scenes = { a: sampleScene(true), b: sampleScene(false), p: personScene() };
    const comp = new Compositor(canvas, {
      resolve: (layer) => {
        const src = scenes[layer.clip.id];
        return src ? { key: `sample:${layer.clip.id}`, source: src, width: src.width, height: src.height, version: 1 } : null;
      },
    });
    const matte = { canvas: personMatte(), version: 1 };
    comp.personMatte = (layer) => (layer.clip?.id === 'p' ? matte : null);
    comp.resize(W, H, W, H);
    shared = { comp, canvas };
  } catch {
    shared = false;
  }
  return shared;
}

function mediaLayer(id, extra = {}) {
  return { kind: 'media', clip: { id }, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, reveal: 1, blend: 'normal', width: W * 2, height: H * 2, crop: { l: 0, t: 0, r: 0, b: 0 }, adjust: DEFAULT_ADJUST, filter: null, ...extra };
}

/** Render a look into ctx2d now (and cache it). */
function drawLook(ctx2d, kind, id, progress, time) {
  const key = `${kind}:${id}:${progress}:${time}`;
  const hit = cache.get(key);
  if (hit) {
    ctx2d.drawImage(hit, 0, 0);
    return;
  }
  const e = engine();
  if (!e) {
    ctx2d.fillStyle = '#333';
    ctx2d.fillRect(0, 0, W, H);
    return;
  }
  let layers;
  if (kind === 'transition') layers = [{ kind: 'transition', id, progress, from: mediaLayer('a'), to: mediaLayer('b') }];
  else if (kind === 'filter') layers = [mediaLayer('a', { filter: id ? { id, intensity: 100 } : null })];
  else if (kind === 'effect') layers = effectLayers(id, time);
  else if (kind === 'stack') layers = [mediaLayer('p', { effects: stacks.get(id) || [], fxTime: time * 1e6, fxDur: 2e6 })];
  else layers = [mediaLayer('a')];
  e.comp.render(layers, { settings: { background: { type: 'color', color: '#000000' } }, time });
  ctx2d.drawImage(e.canvas, 0, 0);
  // Keep a copy so re-rendering the grid is cheap.
  const keep = document.createElement('canvas');
  keep.width = W;
  keep.height = H;
  keep.getContext('2d').drawImage(e.canvas, 0, 0);
  cache.set(key, keep);
}

/* Lazy rendering: tiles draw when visible, within a small time budget per frame. */
const jobs = new Map(); // canvas -> draw()
let observer = null;
let pumping = false;

function pump() {
  pumping = false;
  const start = performance.now();
  for (const [canvas, draw] of jobs) {
    if (!canvas.isConnected) {
      jobs.delete(canvas);
      continue;
    }
    if (!canvas.dataset.visible) continue;
    jobs.delete(canvas);
    observer?.unobserve(canvas);
    draw();
    if (performance.now() - start > 10) break;
  }
  if ([...jobs.keys()].some((c) => c.dataset.visible)) schedulePump();
}

function schedulePump() {
  if (pumping) return;
  pumping = true;
  requestAnimationFrame(pump);
}

function deferDraw(canvas, draw) {
  if (typeof IntersectionObserver !== 'function' || typeof requestAnimationFrame !== 'function') {
    draw();
    return;
  }
  observer ||= new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) en.target.dataset.visible = '1';
      else delete en.target.dataset.visible;
    }
    schedulePump();
  }, { rootMargin: '200px' });
  jobs.set(canvas, draw);
  observer.observe(canvas);
}

/** Draw a preview into a new canvas. kind: 'effect' | 'filter' | 'transition' | 'none'. */
export function lookPreview(kind, id, { progress = 0.5, time = 0.6, lazy = true } = {}) {
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  out.className = 'tile-canvas';
  out.setAttribute('aria-hidden', 'true');
  const ctx2d = out.getContext('2d');
  if (!ctx2d) return out;
  const key = `${kind}:${id}:${progress}:${time}`;
  if (!lazy || cache.has(key)) drawLook(ctx2d, kind, id, progress, time);
  else deferDraw(out, () => drawLook(ctx2d, kind, id, progress, time));
  return out;
}

/**
 * Preview of an effect list on the sample scene with a person, as a clip's
 * own stack (style looks). key names the list for the cache.
 */
export function stackPreview(effects, key, opts) {
  stacks.set(key, effects);
  return lookPreview('stack', key, opts);
}

/**
 * Animate a preview while hovered: transitions sweep, effects run over time,
 * filters wipe back and forth between the original and the look.
 */
export function animatePreview(canvas, kind, id) {
  let raf = 0;
  let start = 0;
  const e = engine();
  if (!e) return () => {};
  const ctx2d = canvas.getContext('2d');
  const frame = (now) => {
    if (!start) start = now;
    const t = (now - start) / 1000;
    let layers;
    if (kind === 'transition') layers = [{ kind: 'transition', id, progress: (t % 1.6) / 1.6, from: mediaLayer('a'), to: mediaLayer('b') }];
    else if (kind === 'filter') layers = [{ kind: 'transition', id: 'wipe-right', progress: 0.5 - 0.42 * Math.cos(t * 2.2), from: mediaLayer('a'), to: mediaLayer('a', { filter: { id, intensity: 100 } }) }];
    else layers = effectLayers(id, t);
    e.comp.render(layers, { settings: { background: { type: 'color', color: '#000000' } }, time: t });
    ctx2d.drawImage(e.canvas, 0, 0);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** Wire hover/focus animation on a tile whose preview canvas is inside. */
export function hoverAnimate(tileEl, kind, id) {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let stop = null;
  const on = () => {
    if (stop) return;
    const c = tileEl.querySelector('canvas');
    if (c) stop = animatePreview(c, kind, id);
  };
  const off = () => {
    stop?.();
    stop = null;
    const c = tileEl.querySelector('canvas');
    const g = c?.getContext('2d');
    if (g) drawLook(g, kind, id, 0.5, 0.6);
  };
  tileEl.addEventListener('pointerenter', on);
  tileEl.addEventListener('pointerleave', off);
  tileEl.addEventListener('focus', on);
  tileEl.addEventListener('blur', off);
}

/**
 * Preview of a color setup (adjust values and grade) on the sample scene,
 * drawn into canvas (a new one when omitted). Not cached: LUT previews are
 * redrawn once their table has loaded.
 */
export function gradePreview({ adjust = DEFAULT_ADJUST, grade = null } = {}, canvas = null) {
  const out = canvas || document.createElement('canvas');
  out.width = W;
  out.height = H;
  out.className = 'tile-canvas';
  out.setAttribute('aria-hidden', 'true');
  const ctx2d = out.getContext('2d');
  const e = ctx2d ? engine() : null;
  if (!e) {
    ctx2d?.fillRect(0, 0, W, H);
    return out;
  }
  e.comp.render([mediaLayer('a', { adjust: { ...DEFAULT_ADJUST, ...adjust }, grade })], { settings: { background: { type: 'color', color: '#000000' } }, time: 0.6 });
  ctx2d.drawImage(e.canvas, 0, 0);
  return out;
}
