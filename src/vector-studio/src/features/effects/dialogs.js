/**
 * Dialogs of the vector effects. Each builds its controls with the dialog
 * kit and returns { body, read }; openEffectDialog() handles targets, live
 * preview, OK/Cancel and undo. Records keep fractions as fractions; the
 * dialogs show them as percentages.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { WARP_STYLES } from '../../model/warp.js';
import { flattenPath } from '../../model/bezier.js';
import { geometryLeaves, subpathsOf } from '../geometry/nodes-io.js';
import { openEffectDialog, sliderField, choiceField, checkField, selectRow, numberRow, group, originPicker } from './dialog-kit.js';
import { freeDistortMapping, SQUARE_CORNERS, newSeed } from './geom/distort.js';
import { SCRIBBLE_PRESETS } from './geom/scribble.js';
import { registerEffectIcons } from './icons.js';

const pct = (v) => v * 100;
const frac = (v) => v / 100;

function seedButton(onClick) {
  return h('button.btn.small.fx-seed-btn', { type: 'button', onclick: onClick, 'data-tip': 'Draw a new random variation' }, icon('fx-seed', 14), 'New Variation');
}

/** Relative/absolute size slider that converts its value when the mode flips. */
function sizeControl(ctx, { label, value, relative, relMax = 100, absMax = 100, onChange }) {
  const size = (ctx.bounds.w + ctx.bounds.h) / 2 || 100;
  let rel = relative;
  const wrap = h('div.fx-size');
  let slider;
  const make = (v) => {
    slider = rel
      ? sliderField({ label, value: v, min: 0, max: relMax, step: 1, kind: 'percent', fieldMax: 100000, onInput: onChange })
      : sliderField({ label, value: v, min: 0, max: absMax, step: 1, kind: 'length', unit: ctx.unit, fieldMax: 100000, onInput: onChange });
    wrap.replaceChildren(slider.el);
  };
  make(rel ? pct(value) : value);
  const mode = choiceField({
    label: 'Size is',
    value: rel ? 'relative' : 'absolute',
    options: [
      { value: 'relative', label: 'Relative' },
      { value: 'absolute', label: 'Absolute' },
    ],
    onChange: (m) => {
      const v = slider.get();
      rel = m === 'relative';
      make(rel ? (v / size) * 100 : (v / 100) * size);
      onChange();
    },
  });
  return {
    els: [wrap, mode.el],
    read: () => ({ relative: rel, value: rel ? frac(slider.get()) : slider.get() }),
  };
}

// ---- Distort & Transform ----

function puckerBloatDialog(app, opts) {
  return openEffectDialog(app, 'puckerBloat', {
    ...opts,
    build(ctx) {
      const amt = sliderField({ label: 'Amount', value: pct(ctx.start.amount), min: -200, max: 200, kind: 'percent', ends: ['Pucker', 'Bloat'], onInput: ctx.changed });
      return { body: h('div.fx-body', amt.el), read: () => ({ amount: frac(amt.get()) }), focus: () => amt.field };
    },
  });
}

function roughenDialog(app, opts) {
  return openEffectDialog(app, 'roughen', {
    ...opts,
    build(ctx) {
      let seed = ctx.start.seed;
      const size = sizeControl(ctx, { label: 'Size', value: ctx.start.size, relative: ctx.start.relative, onChange: ctx.changed });
      const detail = sliderField({ label: 'Detail (per inch)', value: ctx.start.detail, min: 0, max: 100, integer: true, onInput: ctx.changed });
      const pts = choiceField({ label: 'Points', value: ctx.start.smooth ? 'smooth' : 'corner', options: [{ value: 'smooth', label: 'Smooth' }, { value: 'corner', label: 'Corner' }], onChange: ctx.changed });
      const reseed = seedButton(() => {
        seed = newSeed();
        ctx.changed();
      });
      return {
        body: h('div.fx-body', group('Options', ...size.els, detail.el), group('Points', pts.el), h('div.fx-actions', reseed)),
        read: () => {
          const s = size.read();
          return { size: s.value, relative: s.relative, detail: detail.get(), smooth: pts.get() === 'smooth', seed };
        },
      };
    },
  });
}

function zigzagDialog(app, opts) {
  return openEffectDialog(app, 'zigzag', {
    ...opts,
    build(ctx) {
      const size = sizeControl(ctx, { label: 'Size', value: ctx.start.size, relative: ctx.start.relative, onChange: ctx.changed });
      const ridges = sliderField({ label: 'Ridges per segment', value: ctx.start.ridges, min: 0, max: 100, integer: true, onInput: ctx.changed });
      const pts = choiceField({ label: 'Points', value: ctx.start.smooth ? 'smooth' : 'corner', options: [{ value: 'smooth', label: 'Smooth' }, { value: 'corner', label: 'Corner' }], onChange: ctx.changed });
      return {
        body: h('div.fx-body', group('Options', ...size.els, ridges.el), group('Points', pts.el)),
        read: () => {
          const s = size.read();
          return { size: s.value, relative: s.relative, ridges: ridges.get(), smooth: pts.get() === 'smooth' };
        },
      };
    },
  });
}

function tweakDialog(app, opts) {
  return openEffectDialog(app, 'tweak', {
    ...opts,
    build(ctx) {
      let seed = ctx.start.seed;
      let rel = ctx.start.relative;
      const wrap = h('div');
      let hs;
      let vs;
      const make = (hv, vv) => {
        const common = rel ? { kind: 'percent', min: 0, max: 100, fieldMax: 100000 } : { kind: 'length', unit: ctx.unit, min: 0, max: Math.max(100, Math.round(Math.max(ctx.bounds.w, ctx.bounds.h))), fieldMax: 100000 };
        hs = sliderField({ label: 'Horizontal', value: hv, ...common, onInput: ctx.changed });
        vs = sliderField({ label: 'Vertical', value: vv, ...common, onInput: ctx.changed });
        wrap.replaceChildren(hs.el, vs.el);
      };
      make(rel ? pct(ctx.start.h) : ctx.start.h, rel ? pct(ctx.start.v) : ctx.start.v);
      const mode = choiceField({
        label: 'Amounts are',
        value: rel ? 'relative' : 'absolute',
        options: [{ value: 'relative', label: 'Relative' }, { value: 'absolute', label: 'Absolute' }],
        onChange: (m) => {
          const H = hs.get();
          const V = vs.get();
          rel = m === 'relative';
          make(rel ? (H / (ctx.bounds.w || 1)) * 100 : (H / 100) * ctx.bounds.w, rel ? (V / (ctx.bounds.h || 1)) * 100 : (V / 100) * ctx.bounds.h);
          ctx.changed();
        },
      });
      const anchors = checkField({ label: 'Anchor points', value: ctx.start.anchors, onChange: ctx.changed });
      const ins = checkField({ label: 'Incoming handles', value: ctx.start.inHandles, onChange: ctx.changed });
      const outs = checkField({ label: 'Outgoing handles', value: ctx.start.outHandles, onChange: ctx.changed });
      const reseed = seedButton(() => {
        seed = newSeed();
        ctx.changed();
      });
      return {
        body: h('div.fx-body', group('Amount', wrap, mode.el), group('Modify', h('div.fx-checks', anchors.el, ins.el, outs.el)), h('div.fx-actions', reseed)),
        read: () => ({ h: rel ? frac(hs.get()) : hs.get(), v: rel ? frac(vs.get()) : vs.get(), relative: rel, anchors: anchors.get(), inHandles: ins.get(), outHandles: outs.get(), seed }),
      };
    },
  });
}

function twistDialog(app, opts) {
  return openEffectDialog(app, 'twist', {
    ...opts,
    build(ctx) {
      const angle = sliderField({ label: 'Angle', value: ctx.start.angle, min: -360, max: 360, kind: 'angle', fieldMin: -3600, fieldMax: 3600, onInput: ctx.changed });
      return { body: h('div.fx-body', angle.el), read: () => ({ angle: angle.get() }), focus: () => angle.field };
    },
  });
}

function transformDialog(app, opts) {
  return openEffectDialog(app, 'transform', {
    ...opts,
    className: 'fx-transform',
    build(ctx) {
      const s = ctx.start;
      let linked = Math.abs(s.scaleH - s.scaleV) < 1e-9;
      const reach = Math.max(100, Math.round(Math.max(ctx.bounds.w, ctx.bounds.h)));
      let sh;
      let sv;
      const onScale = (which) => (v) => {
        if (linked) (which === 'h' ? sv : sh).set(v);
        ctx.changed();
      };
      sh = sliderField({ label: 'Horizontal', value: pct(s.scaleH), min: 0, max: 200, kind: 'percent', fieldMin: -2000, fieldMax: 2000, onInput: onScale('h') });
      sv = sliderField({ label: 'Vertical', value: pct(s.scaleV), min: 0, max: 200, kind: 'percent', fieldMin: -2000, fieldMax: 2000, onInput: onScale('v') });
      const link = h('button.icon-btn.small.fx-link', { type: 'button', 'aria-label': 'Constrain proportions', 'aria-pressed': String(linked), 'data-tip': 'Constrain proportions' }, icon(linked ? 'fx-link' : 'fx-unlink', 16));
      link.addEventListener('click', () => {
        linked = !linked;
        link.setAttribute('aria-pressed', String(linked));
        link.replaceChildren(icon(linked ? 'fx-link' : 'fx-unlink', 16));
        if (linked) {
          sv.set(sh.get());
          ctx.changed();
        }
      });
      const mh = sliderField({ label: 'Horizontal', value: s.moveH, min: -reach, max: reach, kind: 'length', unit: ctx.unit, fieldMin: -100000, fieldMax: 100000, onInput: ctx.changed });
      const mv = sliderField({ label: 'Vertical', value: s.moveV, min: -reach, max: reach, kind: 'length', unit: ctx.unit, fieldMin: -100000, fieldMax: 100000, onInput: ctx.changed });
      const angle = sliderField({ label: 'Angle', value: s.angle, min: -180, max: 180, kind: 'angle', fieldMin: -3600, fieldMax: 3600, onInput: ctx.changed });
      const rx = checkField({ label: 'Reflect X', value: s.reflectX, onChange: ctx.changed });
      const ry = checkField({ label: 'Reflect Y', value: s.reflectY, onChange: ctx.changed });
      let seed = s.seed;
      const random = checkField({ label: 'Random', value: s.random, onChange: ctx.changed });
      const strokes = checkField({ label: 'Scale Strokes & Effects', value: s.scaleStrokes, onChange: ctx.changed });
      const origin = originPicker({ value: s.origin, onChange: ctx.changed });
      const copies = numberRow({ label: 'Copies', value: s.copies, min: 0, max: 1000, integer: true, onInput: ctx.changed });
      const reseed = seedButton(() => {
        seed = newSeed();
        ctx.changed();
      });
      const body = h(
        'div.fx-body',
        group('Scale', h('div.fx-linked', h('div', sh.el, sv.el), link)),
        group('Move', mh.el, mv.el),
        group('Rotate', angle.el),
        group('Options', h('div.fx-options', h('div.fx-checks', rx.el, ry.el, random.el, strokes.el), h('div.fx-origin-wrap', h('span.fx-label', 'Reference point'), origin.el)), copies.el, h('div.fx-actions', reseed)),
      );
      return {
        body,
        read: () => ({ scaleH: frac(sh.get()), scaleV: frac(sv.get()), moveH: mh.get(), moveV: mv.get(), angle: angle.get(), reflectX: rx.get(), reflectY: ry.get(), random: random.get(), origin: origin.get(), copies: copies.get(), seed, scaleStrokes: strokes.get() }),
      };
    },
  });
}

/** Outlines of the targets in document space, flattened, for the Free Distort preview. */
function previewOutlines(ctx) {
  const leaves = geometryLeaves(ctx.doc, ctx.targets.map((n) => n.id));
  const polys = [];
  for (const n of leaves) for (const s of subpathsOf(ctx.doc, n)) polys.push({ pts: flattenPath(s.anchors, s.closed, 0.5), closed: s.closed });
  if (!polys.length) {
    const b = ctx.bounds;
    polys.push({ pts: [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], closed: true });
  }
  return polys;
}

function freeDistortDialog(app, opts) {
  return openEffectDialog(app, 'freeDistort', {
    ...opts,
    className: 'fx-free-distort',
    build(ctx) {
      const b = ctx.bounds.w > 0 && ctx.bounds.h > 0 ? ctx.bounds : { ...ctx.bounds, w: Math.max(1, ctx.bounds.w), h: Math.max(1, ctx.bounds.h) };
      let corners = ctx.start.corners.map((c) => ({ ...c }));
      const polys = previewOutlines(ctx);
      // Preview space: the box drawn at 50% of a 320x220 view, centered, so corners can move well outside it.
      const VW = 320;
      const VH = 220;
      const k = Math.min((VW * 0.5) / b.w, (VH * 0.5) / b.h);
      const bx = (VW - b.w * k) / 2;
      const by = (VH - b.h * k) / 2;
      const toView = (u, v) => ({ x: bx + u * b.w * k, y: by + v * b.h * k });
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
      svg.setAttribute('class', 'fx-fd-view');
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Corners of the distortion. Drag a corner, or focus it and use the arrow keys.');
      const frame = document.createElementNS(NS, 'path');
      frame.setAttribute('class', 'fx-fd-frame');
      const art = document.createElementNS(NS, 'path');
      art.setAttribute('class', 'fx-fd-art');
      svg.append(frame, art);
      const names = ['Top left corner', 'Top right corner', 'Bottom right corner', 'Bottom left corner'];
      const handles = corners.map((_, i) => {
        const g = document.createElementNS(NS, 'rect');
        g.setAttribute('class', 'fx-fd-handle');
        g.setAttribute('width', '12');
        g.setAttribute('height', '12');
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'slider');
        g.setAttribute('aria-label', names[i]);
        svg.append(g);
        return g;
      });
      const draw = () => {
        const f = freeDistortMapping(corners, { x: 0, y: 0, w: 1, h: 1 });
        const ptsView = (p) => {
          const q = f((p.x - b.x) / b.w, (p.y - b.y) / b.h);
          const v = toView(q.x, q.y);
          return `${v.x.toFixed(1)} ${v.y.toFixed(1)}`;
        };
        art.setAttribute('d', polys.map((p) => `M${p.pts.map(ptsView).join('L')}${p.closed ? 'Z' : ''}`).join(''));
        frame.setAttribute('d', `M${corners.map((c) => { const v = toView(c.x, c.y); return `${v.x.toFixed(1)} ${v.y.toFixed(1)}`; }).join('L')}Z`);
        corners.forEach((c, i) => {
          const v = toView(c.x, c.y);
          handles[i].setAttribute('x', String(v.x - 6));
          handles[i].setAttribute('y', String(v.y - 6));
          handles[i].setAttribute('aria-valuetext', `${Math.round(c.x * 100)}% across, ${Math.round(c.y * 100)}% down`);
        });
      };
      const moveTo = (i, u, v) => {
        corners[i] = { x: Math.max(-1, Math.min(2, u)), y: Math.max(-1, Math.min(2, v)) };
        draw();
        ctx.changed();
      };
      handles.forEach((g, i) => {
        g.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          g.setPointerCapture?.(e.pointerId);
          g.focus();
          const rect = svg.getBoundingClientRect();
          const sx = VW / (rect.width || VW);
          const sy = VH / (rect.height || VH);
          const move = (ev) => moveTo(i, ((ev.clientX - rect.left) * sx - bx) / (b.w * k), ((ev.clientY - rect.top) * sy - by) / (b.h * k));
          const up = () => {
            g.removeEventListener('pointermove', move);
            g.removeEventListener('pointerup', up);
          };
          g.addEventListener('pointermove', move);
          g.addEventListener('pointerup', up);
        });
        g.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 0.1 : 0.01;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          moveTo(i, corners[i].x + d[0], corners[i].y + d[1]);
        });
      });
      draw();
      const reset = h('button.btn.small', {
        type: 'button',
        onclick: () => {
          corners = SQUARE_CORNERS.map((c) => ({ ...c }));
          draw();
          ctx.changed();
        },
      }, 'Reset');
      return { body: h('div.fx-body', h('div.fx-fd', svg), h('div.fx-actions', reset)), read: () => ({ corners: corners.map((c) => ({ ...c })) }), focus: () => handles[0] };
    },
  });
}

// ---- Path ----

function offsetPathDialog(app, opts) {
  return openEffectDialog(app, 'offsetPath', {
    ...opts,
    build(ctx) {
      const offset = numberRow({ label: 'Offset', value: ctx.start.offset, kind: 'length', unit: ctx.unit, min: -10000, max: 10000, onInput: ctx.changed });
      const joins = selectRow({ label: 'Joins', value: ctx.start.joins, options: [{ value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' }], onChange: ctx.changed });
      const miter = numberRow({ label: 'Miter limit', value: ctx.start.miterLimit, min: 1, max: 500, onInput: ctx.changed });
      return { body: h('div.fx-body', offset.el, joins.el, miter.el), read: () => ({ offset: offset.get(), joins: joins.get(), miterLimit: miter.get() }), focus: () => offset.field };
    },
  });
}

// ---- Convert to Shape ----

function convertShapeDialog(app, opts) {
  return openEffectDialog(app, 'convertShape', {
    ...opts,
    title: 'Shape Options',
    build(ctx) {
      const s = ctx.start;
      const shape = selectRow({ label: 'Shape', value: s.shape, options: [{ value: 'rectangle', label: 'Rectangle' }, { value: 'roundedRectangle', label: 'Rounded Rectangle' }, { value: 'ellipse', label: 'Ellipse' }], onChange: () => sync() });
      const mode = choiceField({ label: 'Size', value: s.sizeMode, options: [{ value: 'absolute', label: 'Absolute' }, { value: 'relative', label: 'Relative' }], onChange: () => sync() });
      const w = numberRow({ label: 'Width', value: s.width, kind: 'length', unit: ctx.unit, min: 0, max: 100000, onInput: ctx.changed });
      const hh = numberRow({ label: 'Height', value: s.height, kind: 'length', unit: ctx.unit, min: 0, max: 100000, onInput: ctx.changed });
      const ew = numberRow({ label: 'Extra width', value: s.extraW, kind: 'length', unit: ctx.unit, min: -10000, max: 10000, onInput: ctx.changed });
      const eh = numberRow({ label: 'Extra height', value: s.extraH, kind: 'length', unit: ctx.unit, min: -10000, max: 10000, onInput: ctx.changed });
      const radius = numberRow({ label: 'Corner radius', value: s.radius, kind: 'length', unit: ctx.unit, min: 0, max: 10000, onInput: ctx.changed });
      const sync = () => {
        const abs = mode.get() === 'absolute';
        w.el.hidden = !abs;
        hh.el.hidden = !abs;
        ew.el.hidden = abs;
        eh.el.hidden = abs;
        radius.el.hidden = shape.get() !== 'roundedRectangle';
        ctx.changed();
      };
      sync();
      return {
        body: h('div.fx-body', shape.el, group('Options', mode.el, w.el, hh.el, ew.el, eh.el, radius.el)),
        read: () => ({ shape: shape.get(), sizeMode: mode.get(), width: w.get(), height: hh.get(), extraW: ew.get(), extraH: eh.get(), radius: radius.get() }),
      };
    },
  });
}

// ---- Warp ----

function warpDialog(app, opts) {
  registerEffectIcons();
  return openEffectDialog(app, 'warp', {
    ...opts,
    title: 'Warp Options',
    className: 'fx-warp',
    build(ctx) {
      const s = ctx.start;
      let style = s.style;
      const name = h('span.fx-warp-name', { 'aria-live': 'polite' });
      const buttons = WARP_STYLES.map((st) =>
        h('button.fx-warp-style', {
          type: 'button',
          role: 'radio',
          'aria-label': st.label,
          'data-tip': st.label,
          'data-style': st.id,
          onclick: () => pick(st.id),
        }, icon(`warp-${st.id}`, 22)),
      );
      const grid = h('div.fx-warp-grid', { role: 'radiogroup', 'aria-label': 'Style' }, buttons);
      grid.addEventListener('keydown', (e) => {
        const i = WARP_STYLES.findIndex((x) => x.id === style);
        const cols = 5;
        const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
        if (d == null) return;
        e.preventDefault();
        e.stopPropagation();
        const j = Math.max(0, Math.min(WARP_STYLES.length - 1, i + d));
        pick(WARP_STYLES[j].id);
        buttons[j].focus();
      });
      const pick = (id) => {
        style = id;
        buttons.forEach((b, i) => {
          const on = WARP_STYLES[i].id === id;
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        });
        name.textContent = WARP_STYLES.find((x) => x.id === id)?.label || '';
        ctx.changed();
      };
      pick(style);
      const orient = choiceField({ label: 'Bend along', value: s.vertical ? 'vertical' : 'horizontal', options: [{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }], onChange: ctx.changed });
      const bend = sliderField({ label: 'Bend', value: pct(s.bend), min: -100, max: 100, kind: 'percent', onInput: ctx.changed });
      const dh = sliderField({ label: 'Horizontal', value: pct(s.distortH), min: -100, max: 100, kind: 'percent', onInput: ctx.changed });
      const dv = sliderField({ label: 'Vertical', value: pct(s.distortV), min: -100, max: 100, kind: 'percent', onInput: ctx.changed });
      return {
        body: h('div.fx-body', h('div.fx-row.fx-warp-head', h('span.fx-label', 'Style'), name), grid, orient.el, bend.el, group('Distortion', dh.el, dv.el)),
        read: () => ({ style, vertical: orient.get() === 'vertical', bend: frac(bend.get()), distortH: frac(dh.get()), distortV: frac(dv.get()) }),
        focus: () => buttons.find((b) => b.tabIndex === 0),
      };
    },
  });
}

// ---- Scribble ----

const SCRIBBLE_KEYS = ['angle', 'overlap', 'overlapVar', 'lineWidth', 'curviness', 'curvinessVar', 'spacing', 'spacingVar'];

function scribbleDialog(app, opts) {
  return openEffectDialog(app, 'scribble', {
    ...opts,
    title: 'Scribble Options',
    className: 'fx-scribble',
    build(ctx) {
      const s = ctx.start;
      let seed = s.seed;
      let applying = false;
      const edited = () => {
        if (!applying) preset.set('custom');
        ctx.changed();
      };
      const preset = selectRow({
        label: 'Preset',
        value: s.preset,
        options: [{ value: 'custom', label: 'Custom' }, ...SCRIBBLE_PRESETS.map((p) => ({ value: p.id, label: p.label }))],
        onChange: (id) => {
          const p = SCRIBBLE_PRESETS.find((x) => x.id === id);
          if (!p) return;
          applying = true;
          for (const k of SCRIBBLE_KEYS) f[k].set(k === 'curviness' || k === 'curvinessVar' ? pct(p[k]) : p[k]);
          applying = false;
          ctx.changed();
        },
      });
      const len = { kind: 'length', unit: ctx.unit };
      const f = {
        angle: sliderField({ label: 'Angle', value: s.angle, min: -180, max: 180, kind: 'angle', fieldMin: -360, fieldMax: 360, onInput: edited }),
        overlap: sliderField({ label: 'Path overlap', value: s.overlap, min: -20, max: 20, step: 0.5, ...len, fieldMin: -1000, fieldMax: 1000, onInput: edited, ends: ['Inside', 'Outside'] }),
        overlapVar: sliderField({ label: 'Variation', value: s.overlapVar, min: 0, max: 20, step: 0.5, ...len, fieldMax: 1000, onInput: edited }),
        lineWidth: sliderField({ label: 'Stroke width', value: s.lineWidth, min: 0.1, max: 20, step: 0.1, ...len, fieldMin: 0.01, fieldMax: 1000, onInput: edited }),
        curviness: sliderField({ label: 'Curviness', value: pct(s.curviness), min: 0, max: 100, kind: 'percent', onInput: edited, ends: ['Angular', 'Loopy'] }),
        curvinessVar: sliderField({ label: 'Variation', value: pct(s.curvinessVar), min: 0, max: 100, kind: 'percent', onInput: edited }),
        spacing: sliderField({ label: 'Spacing', value: s.spacing, min: 0.5, max: 50, step: 0.5, ...len, fieldMin: 0.1, fieldMax: 1000, onInput: edited, ends: ['Tight', 'Loose'] }),
        spacingVar: sliderField({ label: 'Variation', value: s.spacingVar, min: 0, max: 20, step: 0.5, ...len, fieldMax: 1000, onInput: edited }),
      };
      const reseed = seedButton(() => {
        seed = newSeed();
        ctx.changed();
      });
      return {
        body: h(
          'div.fx-body',
          preset.el,
          f.angle.el,
          group('Path Overlap', f.overlap.el, f.overlapVar.el),
          group('Line Options', f.lineWidth.el, f.curviness.el, f.curvinessVar.el, f.spacing.el, f.spacingVar.el),
          h('div.fx-actions', reseed),
        ),
        read: () => {
          const out = { preset: preset.get(), seed };
          for (const k of SCRIBBLE_KEYS) out[k] = k === 'curviness' || k === 'curvinessVar' ? frac(f[k].get()) : f[k].get();
          return out;
        },
        focus: () => preset.select,
      };
    },
  });
}

/** Custom dialogs by effect record type. */
export const EFFECT_DIALOGS = {
  freeDistort: freeDistortDialog,
  puckerBloat: puckerBloatDialog,
  roughen: roughenDialog,
  transform: transformDialog,
  tweak: tweakDialog,
  twist: twistDialog,
  zigzag: zigzagDialog,
  offsetPath: offsetPathDialog,
  convertShape: convertShapeDialog,
  warp: warpDialog,
  scribble: scribbleDialog,
};
