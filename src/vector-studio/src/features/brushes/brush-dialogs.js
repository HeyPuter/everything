/**
 * Brush dialogs: New Brush (choose a type), the per-type Brush Options
 * dialogs and Options of Selected Object. Each options dialog shows a live
 * preview of the brush on a sample stroke; with Preview on, the artwork
 * using the brush updates too (inside a transaction Cancel rolls back).
 *
 * brushOptionsDialog(app, brush, { scope: 'brush' | 'stroke' }) resolves to
 * the edited brush (scope 'brush') or the stroke overrides (scope
 * 'stroke'), or null when cancelled.
 */
import { h } from '../../lib/dom.js';
import { parseNumber } from '../../lib/units.js';
import { BRUSH_TYPES, BRISTLE_SHAPES, COLORIZE_METHODS, artFromNodes } from './brush-model.js';
import { drawBrushPreview, inkColor } from './thumbs.js';
import { orientedArt } from './generate.js';
import { tracePath } from '../../render/draw.js';

let uidCounter = 0;
const uid = (p) => `${p}-${++uidCounter}`;

const MODES = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'random', label: 'Random' },
  { value: 'pressure', label: 'Pressure' },
  { value: 'velocity', label: 'Velocity' },
];

const fmt = (v, unit) => `${Number((v ?? 0).toFixed(2))}${unit}`;

/** A small numeric input with a unit suffix; Up/Down step (Shift 10x). */
function num(value, { unit = '', min = -Infinity, max = Infinity, step = 1, label }) {
  const input = h('input.bo-num', { type: 'text', inputmode: 'decimal', spellcheck: false, autocomplete: 'off', value: fmt(value, unit), 'aria-label': label });
  const get = () => {
    const v = parseNumber(input.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : NaN;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = Number.isFinite(get()) ? get() : 0;
    input.value = fmt(Math.min(max, Math.max(min, base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1))), unit);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('blur', () => {
    const v = get();
    if (Number.isFinite(v)) input.value = fmt(v, unit);
  });
  return { el: input, get, set: (v) => (input.value = fmt(v, unit)) };
}

function select(options, value, label) {
  const el = h('select.select', { 'aria-label': label }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return { el, get: () => el.value, set: (v) => (el.value = v) };
}

function check(label, value) {
  const id = uid('bo-chk');
  const input = h('input', { type: 'checkbox', id, checked: Boolean(value) });
  return { el: h('div.check-row', input, h('label', { for: id }, label)), get: () => input.checked, input };
}

function radios(label, options, value) {
  const name = uid('bo-radio');
  const el = h(
    'div.radio-group',
    { role: 'radiogroup', 'aria-label': label },
    options.map((o) => h('label.radio', h('input', { type: 'radio', name, value: o.value, checked: o.value === value }), o.label)),
  );
  return { el, get: () => el.querySelector('input:checked')?.value ?? value };
}

const row = (label, ...controls) => h('div.bo-row', h('span.bo-label', label), h('div.bo-controls', ...controls));

/** Fixed / Random / Pressure value with a variation. */
function variableField(label, v, { unit = '', min = 0, max = 1000, step = 1 } = {}) {
  const mode = select(MODES, v?.mode || 'fixed', `${label} variation mode`);
  const value = num(v?.value ?? 0, { unit, min, max, step, label });
  const variation = num(v?.variation ?? 0, { unit, min: 0, max, step, label: `${label} variation` });
  const sync = () => (variation.el.disabled = mode.get() === 'fixed');
  mode.el.addEventListener('change', sync);
  sync();
  return {
    el: row(label, value.el, mode.el, h('span.bo-sub', 'Variation'), variation.el),
    get: () => ({ mode: mode.get(), value: value.get(), variation: mode.get() === 'fixed' ? 0 : variation.get() }),
  };
}

/** Fixed / Random / Pressure range from min to max. */
function rangeField(label, r, { unit = '', min = 0, max = 1000, step = 1 } = {}) {
  const mode = select(MODES, r?.mode || 'fixed', `${label} mode`);
  const lo = num(r?.min ?? 0, { unit, min, max, step, label: `${label} minimum` });
  const hi = num(r?.max ?? r?.min ?? 0, { unit, min, max, step, label: `${label} maximum` });
  const sync = () => (hi.el.disabled = mode.get() === 'fixed');
  mode.el.addEventListener('change', sync);
  sync();
  return {
    el: row(label, lo.el, h('span.bo-sub', 'to'), hi.el, mode.el),
    get: () => {
      const m = mode.get();
      const a = lo.get();
      return { mode: m, min: a, max: m === 'fixed' ? a : hi.get() };
    },
  };
}

/** The solid colors of a brush's artwork (art, or pattern tiles), most used first. */
export function brushArtColors(brush) {
  const counts = new Map();
  const add = (p) => {
    const list = p?.type === 'solid' ? [p.color] : p?.stops ? p.stops.map((st) => st.color) : [];
    for (const c of list) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) || 0) + 1);
  };
  const arts = [brush.art, ...Object.values(brush.tiles || {})].filter((a) => a && typeof a === 'object' && a.items);
  for (const art of arts) for (const it of art.items) {
    add(it.fill);
    if (it.strokeWidth > 0) add(it.stroke);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

function colorizeField(c, artColors = []) {
  const method = select(COLORIZE_METHODS, c?.method || 'none', 'Colorization method');
  const key = h('input', { type: 'color', value: c?.key || '#000000', 'aria-label': 'Key color' });
  // The key color is picked from the artwork's own colors (or any color).
  const chips = artColors.slice(0, 12).map((col) =>
    h('button.bo-key-chip', { type: 'button', style: { background: col }, 'aria-label': `Use ${col.toUpperCase()} as the key color`, 'data-tip': col.toUpperCase(), onclick: () => {
      key.value = col;
      key.dispatchEvent(new Event('input', { bubbles: true }));
    } }),
  );
  const keyWrap = h('span.bo-key', h('span.bo-sub', 'Key color'), key, chips.length ? h('span.bo-key-chips', { role: 'group', 'aria-label': 'Artwork colors' }, chips) : null);
  const help = h('p.bo-help');
  const HELP = {
    none: 'The artwork keeps its own colors.',
    tints: 'Dark parts take the stroke color; lighter parts become its tints.',
    tintsShades: 'Black and white stay; the tones between take the stroke color.',
    hueShift: 'The key color becomes the stroke color; other colors turn their hue alike.',
  };
  const sync = () => {
    keyWrap.hidden = method.get() !== 'hueShift';
    help.textContent = HELP[method.get()];
  };
  method.el.addEventListener('change', sync);
  sync();
  return { el: h('div.bo-colorize', row('Colorization', method.el, keyWrap), help), get: () => ({ method: method.get(), key: key.value }) };
}

function slider(label, value, { min = 1, max = 100, unit = '%' } = {}) {
  const id = uid('bo-range');
  const input = h('input', { type: 'range', id, min, max, step: 1, value });
  const out = h('output.range-out', { for: id }, `${value}${unit}`);
  input.addEventListener('input', () => (out.textContent = `${input.value}${unit}`));
  return { el: h('div.bo-row', h('label.bo-label', { for: id }, label), h('div.bo-controls.range-wrap', input, out)), get: () => Number(input.value) };
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** SVG path data for subpaths. */
function pathData(subpaths) {
  let d = '';
  const n = (v) => Number(v.toFixed(2));
  const sink = {
    moveTo: (x, y) => (d += `M${n(x)} ${n(y)}`),
    lineTo: (x, y) => (d += `L${n(x)} ${n(y)}`),
    bezierCurveTo: (a, b, c, e, x, y) => (d += `C${n(a)} ${n(b)} ${n(c)} ${n(e)} ${n(x)} ${n(y)}`),
    closePath: () => (d += 'Z'),
  };
  for (const sp of subpaths) tracePath(sink, sp.anchors, sp.closed);
  return d;
}

/**
 * Art brush guides on the artwork: the art as it runs along the stroke
 * (its direction applied) with two dashed guides to drag. The part
 * between them stretches; the ends keep their size. Synced with the Start
 * and End fields (percent of the art's length).
 */
function guideEditor(brush, g0, g1) {
  const art = orientedArt(brush.art, brush.direction || 'right');
  if (!art || typeof document === 'undefined') return null;
  const B = art.bounds;
  const pad = Math.max(B.w, B.h) * 0.06;
  const svg = svgEl('svg', { viewBox: `${B.x - pad} ${B.y - pad} ${B.w + 2 * pad} ${B.h + 2 * pad}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  for (const it of art.items) {
    const paint = (p) => (p?.type === 'solid' ? p.color : p?.stops?.[0]?.color || 'none');
    svg.append(svgEl('path', { d: pathData(it.subpaths), fill: it.fill ? paint(it.fill) : 'none', stroke: it.stroke && it.strokeWidth > 0 ? paint(it.stroke) : 'none', 'stroke-width': it.strokeWidth || 0, 'fill-rule': it.fillRule || 'nonzero', opacity: it.opacity ?? 1 }));
  }
  const band = svgEl('rect', { class: 'bo-guide-band', y: B.y - pad, height: B.h + 2 * pad });
  svg.prepend(band);
  const lines = [g0, g1].map(() => svgEl('line', { class: 'bo-guide', y1: B.y - pad, y2: B.y + B.h + pad, 'vector-effect': 'non-scaling-stroke' }));
  svg.append(...lines);
  const wrap = h('div.bo-guides', { role: 'group', 'aria-label': 'Guides on the artwork: drag to set where the art stretches' }, svg);
  const frac = (f) => f.get() / 100;
  const place = () => {
    const a = Math.min(1, Math.max(0, frac(g0) || 0));
    const b = Math.min(1, Math.max(0, frac(g1) || 0));
    [a, b].forEach((v, i) => {
      lines[i].setAttribute('x1', String(B.x + v * B.w));
      lines[i].setAttribute('x2', String(B.x + v * B.w));
    });
    band.setAttribute('x', String(B.x + Math.min(a, b) * B.w));
    band.setAttribute('width', String(Math.abs(b - a) * B.w));
  };
  let enabled = true;
  const toFrac = (clientX) => {
    const r = svg.getBoundingClientRect();
    // The art is centered in the box at its aspect ratio.
    const s = Math.min(r.width / (B.w + 2 * pad), r.height / (B.h + 2 * pad)) || 1;
    const x0 = r.left + (r.width - (B.w + 2 * pad) * s) / 2 + pad * s;
    return Math.min(1, Math.max(0, (clientX - x0) / (B.w * s)));
  };
  svg.addEventListener('pointerdown', (e) => {
    if (!enabled) return;
    const f = toFrac(e.clientX);
    // The nearer guide follows the pointer.
    const field = Math.abs(f - frac(g0)) <= Math.abs(f - frac(g1)) ? g0 : g1;
    const move = (ev) => {
      field.set(Math.round(toFrac(ev.clientX) * 1000) / 10);
      field.el.dispatchEvent(new Event('input', { bubbles: true }));
      place();
    };
    move(e);
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      field.el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  });
  for (const f of [g0, g1]) f.el.addEventListener('input', place);
  place();
  return {
    el: wrap,
    setEnabled(on) {
      enabled = on;
      wrap.classList.toggle('disabled', !on);
    },
  };
}

/** Fields for a brush type. `scope` 'stroke' shows only what a single stroke can override. */
function typeFields(app, brush, scope, selectionArt) {
  const f = {};
  const parts = [];
  const add = (key, field) => {
    f[key] = field;
    parts.push(field.el);
  };
  switch (brush.type) {
    case 'calligraphic':
      add('angle', variableField('Angle', brush.angle, { unit: '°', min: -180, max: 180 }));
      add('roundness', variableField('Roundness', brush.roundness, { unit: '%', min: 0, max: 100 }));
      add('size', variableField('Size', brush.size, { unit: ' pt', min: 0, max: 1296, step: 0.5 }));
      break;
    case 'scatter':
      add('size', rangeField('Size', brush.size, { unit: '%', min: 1, max: 1000 }));
      add('spacing', rangeField('Spacing', brush.spacing, { unit: '%', min: 1, max: 10000 }));
      add('scatter', rangeField('Scatter', brush.scatter, { unit: '%', min: -1000, max: 1000 }));
      add('rotation', rangeField('Rotation', brush.rotation, { unit: '°', min: -360, max: 360 }));
      f.rotateRelative = select([{ value: 'page', label: 'Page' }, { value: 'path', label: 'Path' }], brush.rotateRelative || 'page', 'Rotation relative to');
      parts.push(row('Rotation relative to', f.rotateRelative.el));
      add('colorize', colorizeField(brush.colorize, brushArtColors(brush)));
      break;
    case 'art': {
      add('width', variableField('Width', brush.width, { unit: '%', min: 1, max: 1000 }));
      if (scope === 'brush') {
        const scaling = radios('Scale', [
          { value: 'proportional', label: 'Scale proportionally' },
          { value: 'stretch', label: 'Stretch to fit' },
          { value: 'guides', label: 'Stretch between guides' },
        ], brush.scaling || 'stretch');
        const g0 = num((brush.guides?.start ?? 0.25) * 100, { unit: '%', min: 0, max: 100, label: 'Start guide' });
        const g1 = num((brush.guides?.end ?? 0.75) * 100, { unit: '%', min: 0, max: 100, label: 'End guide' });
        f.scaling = scaling;
        f.guides = { get: () => ({ start: g0.get() / 100, end: g1.get() / 100 }) };
        // Guides only matter when stretching between them.
        const editor = guideEditor(brush, g0, g1);
        const syncGuides = () => {
          const on = scaling.get() === 'guides';
          g0.el.disabled = g1.el.disabled = !on;
          editor?.setEnabled(on);
        };
        scaling.el.addEventListener('change', syncGuides);
        parts.push(row('Scale', scaling.el), row('Guides', h('span.bo-sub', 'Start'), g0.el, h('span.bo-sub', 'End'), g1.el));
        if (editor) parts.push(editor.el);
        syncGuides();
        const dir = radios('Direction', [
          { value: 'right', label: '→ Left to right' },
          { value: 'left', label: '← Right to left' },
          { value: 'down', label: '↓ Top to bottom' },
          { value: 'up', label: '↑ Bottom to top' },
        ], brush.direction || 'right');
        f.direction = dir;
        parts.push(row('Direction', dir.el));
        const overlap = radios('Overlap', [
          { value: 'none', label: 'Allow overlap' },
          { value: 'adjust', label: 'Avoid folds in tight bends' },
        ], brush.overlap || 'none');
        f.overlap = overlap;
        parts.push(row('Overlap', overlap.el));
      }
      const fa = check('Flip along', brush.flipAlong);
      const fx = check('Flip across', brush.flipAcross);
      f.flipAlong = fa;
      f.flipAcross = fx;
      parts.push(row('Flip', fa.el, fx.el));
      add('colorize', colorizeField(brush.colorize, brushArtColors(brush)));
      break;
    }
    case 'pattern': {
      add('scale', variableField('Scale', brush.scale, { unit: '%', min: 1, max: 10000 }));
      const sp = num(brush.spacing || 0, { unit: '%', min: 0, max: 10000, label: 'Spacing' });
      f.spacing = sp;
      parts.push(row('Spacing', sp.el));
      if (scope === 'brush') {
        const tiles = {};
        const SLOTS = [
          ['side', 'Side tile'],
          ['outer', 'Outer corner'],
          ['inner', 'Inner corner'],
          ['start', 'Start tile'],
          ['end', 'End tile'],
        ];
        const grid = h('div.bo-tiles');
        for (const [key, label] of SLOTS) {
          const cur = brush.tiles?.[key];
          const opts = [];
          if (cur && typeof cur === 'object') opts.push({ value: 'keep', label: 'Current artwork' });
          opts.push({ value: 'none', label: 'None' });
          if (key === 'outer' || key === 'inner') opts.push({ value: 'auto', label: 'Continue side tiles' });
          if (selectionArt) opts.push({ value: 'selection', label: 'Selected artwork' });
          const initial = cur === 'auto' ? 'auto' : cur && typeof cur === 'object' ? 'keep' : 'none';
          const s = select(opts, initial, label);
          tiles[key] = { sel: s, cur };
          grid.append(h('label.bo-tile', h('span', label), s.el));
        }
        f.tiles = {
          get: () => {
            const out = {};
            for (const [key, { sel, cur }] of Object.entries(tiles)) {
              const v = sel.get();
              out[key] = v === 'keep' ? cur : v === 'auto' ? 'auto' : v === 'selection' ? selectionArt : null;
            }
            return out;
          },
        };
        parts.push(h('div.bo-row.bo-row-top', h('span.bo-label', 'Tiles'), grid));
        const fit = radios('Fit', [
          { value: 'stretch', label: 'Stretch to fit' },
          { value: 'space', label: 'Add space to fit' },
          { value: 'approximate', label: 'Keep tile size' },
        ], brush.fit || 'stretch');
        f.fit = fit;
        parts.push(row('Fit', fit.el));
      } else {
        const fit = radios('Fit', [
          { value: 'stretch', label: 'Stretch to fit' },
          { value: 'space', label: 'Add space to fit' },
          { value: 'approximate', label: 'Keep tile size' },
        ], brush.fit || 'stretch');
        f.fit = fit;
        parts.push(row('Fit', fit.el));
      }
      const fa = check('Flip along', brush.flipAlong);
      const fx = check('Flip across', brush.flipAcross);
      f.flipAlong = fa;
      f.flipAcross = fx;
      parts.push(row('Flip', fa.el, fx.el));
      add('colorize', colorizeField(brush.colorize, brushArtColors(brush)));
      break;
    }
    case 'bristle': {
      const shape = select(BRISTLE_SHAPES, brush.shape || 'roundPoint', 'Shape');
      f.shape = shape;
      parts.push(row('Shape', shape.el));
      const size = num(brush.size ?? 3, { unit: ' pt', min: 0.1, max: 100, step: 0.5, label: 'Size' });
      f.size = size;
      parts.push(row('Size', size.el));
      add('length', slider('Bristle length', brush.length ?? 100, { min: 25, max: 300 }));
      add('density', slider('Bristle density', brush.density ?? 40));
      add('thickness', slider('Bristle thickness', brush.thickness ?? 50));
      add('opacity', slider('Paint opacity', brush.opacity ?? 75));
      add('stiffness', slider('Stiffness', brush.stiffness ?? 50));
      break;
    }
    default:
      break;
  }
  return { fields: f, parts };
}

/** Read field values into brush parameters. Returns null when a number is invalid. */
function readFields(fields) {
  const out = {};
  for (const [k, field] of Object.entries(fields)) {
    if (!field?.get) continue;
    const v = field.get();
    const bad = (x) => typeof x === 'number' && !Number.isFinite(x);
    if (bad(v) || (v && typeof v === 'object' && Object.values(v).some(bad))) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Brush Options for a brush definition (scope 'brush') or the overrides on
 * selected strokes (scope 'stroke'). `onPreview(next | null)` previews on
 * the artwork while Preview is checked.
 */
export async function brushOptionsDialog(app, brush, { scope = 'brush', title, onPreview = null, selectionArt = null, okLabel = 'OK' } = {}) {
  const nameId = uid('bo-name');
  const name = h('input', { type: 'text', id: nameId, value: brush.name || '', spellcheck: false, autocomplete: 'off' });
  const { fields, parts } = typeFields(app, brush, scope, selectionArt);
  const canvas = h('canvas.bo-preview-canvas', { 'aria-hidden': 'true' });
  const previewBox = h('div.bo-preview', { role: 'img', 'aria-label': 'Brush preview' }, canvas);
  const previewChk = onPreview ? check('Preview on artwork', true) : null;
  const error = h('p.form-error', { role: 'alert' });
  const body = h(
    `div.form.brush-options.bo-${brush.type}`,
    scope === 'brush' ? h('div.bo-row', h('label.bo-label', { for: nameId }, 'Name'), h('div.bo-controls', name)) : null,
    previewBox,
    ...parts,
    previewChk?.el,
    error,
  );
  const current = () => {
    const v = readFields(fields);
    if (!v) return null;
    if (scope === 'stroke') return v;
    return { ...brush, ...v, name: name.value.trim() || brush.name };
  };
  let pending = 0;
  const refresh = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const v = current();
      if (!v) {
        error.textContent = 'Enter valid numbers.';
        return;
      }
      error.textContent = '';
      const def = scope === 'stroke' ? { ...brush, ...v } : v;
      const w = Math.max(240, Math.min(420, previewBox.clientWidth || 360));
      drawBrushPreview(canvas, def, { w, h: def.type === 'pattern' ? 96 : 72, color: inkColor(previewBox), corners: def.type === 'pattern' });
      if (onPreview) onPreview(previewChk.get() ? v : null);
    });
  };
  body.addEventListener('input', refresh);
  body.addEventListener('change', refresh);
  const result = await app.dialogs.open({
    title: title || `${BRUSH_TYPES[brush.type].label} Options`,
    body,
    className: 'brush-options-dialog',
    initialFocus: () => (scope === 'brush' ? name : body.querySelector('input, select')),
    onOpen: () => refresh(),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: okLabel,
        primary: true,
        value: () => current(),
        validate: () => {
          if (current()) return true;
          error.textContent = 'Enter valid numbers.';
          return false;
        },
      },
    ],
  });
  if (pending) cancelAnimationFrame(pending);
  return result;
}

/** New Brush: choose a type. Types that need artwork are off without a selection. */
export async function newBrushTypeDialog(app, { hasArt }) {
  const name = uid('nb-type');
  const DESCR = {
    calligraphic: 'A pen nib with an angle, roundness and size.',
    scatter: 'Copies of the selected artwork scattered along the path.',
    art: 'The selected artwork stretched along the path.',
    pattern: 'The selected artwork repeated as tiles along the path.',
    bristle: 'A paintbrush made of many soft bristles.',
  };
  const first = hasArt ? 'art' : 'calligraphic';
  const body = h(
    'div.form.new-brush',
    h(
      'div.nb-types',
      { role: 'radiogroup', 'aria-label': 'Brush type' },
      Object.entries(BRUSH_TYPES).map(([type, t]) => {
        const needsArt = type === 'scatter' || type === 'art' || type === 'pattern';
        const disabled = needsArt && !hasArt;
        return h(
          'label.nb-type',
          { class: disabled ? 'disabled' : '' },
          h('input', { type: 'radio', name, value: type, checked: type === first, disabled }),
          h('span.nb-text', h('strong', t.label), h('span', DESCR[type] + (disabled ? ' Select artwork first.' : ''))),
        );
      }),
    ),
  );
  return app.dialogs.open({
    title: 'New Brush',
    body,
    className: 'new-brush-dialog',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Continue', primary: true, value: () => body.querySelector('input:checked')?.value || null },
    ],
  });
}

/** Brush art from the editor's selection: { art, skipped }. */
export function selectionArt(editor) {
  if (!editor) return { art: null, skipped: 0 };
  return artFromNodes(editor.doc, editor.topSelection().map((id) => editor.doc.get(id)).filter(Boolean));
}
