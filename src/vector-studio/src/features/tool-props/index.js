/**
 * Tool settings in the Properties panel: with nothing selected and a
 * drawing tool active, the panel shows the appearance new artwork gets and
 * a section with that tool's settings (Pencil and Paintbrush fidelity, the
 * brush, Blob Brush and Eraser size, shape tool defaults, the options of
 * the line, arc, spiral and grid tools), edited in place instead of
 * through the tool's options dialog.
 */
import { h } from '../../lib/dom.js';
import { numberField, segmented } from '../../ui/widgets.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { docBrushes, BRUSH_TYPES } from '../brushes/brush-model.js';
import { brushState } from '../brushes/brush-actions.js';

let seq = 0;
const nextId = () => `tp-${++seq}`;

/** Freehand tools keep fidelity and Keep selected on the tool (the Paintbrush also in `opts`/prefs). */
function freehandSettings(tool) {
  const opts = tool.opts;
  const write = (patch) => {
    Object.assign(tool, patch);
    if (opts) {
      tool.opts = { ...tool.opts, ...patch };
      tool.app.prefs.set('paintbrushOptions', tool.opts);
    }
  };
  const fields = [
    { key: 'fidelity', label: 'Fidelity', type: 'range', min: 0, max: 100, value: tool.fidelity ?? 50, hint: 'Accurate to Smooth' },
    { key: 'keepSelected', label: 'Keep selected', type: 'checkbox', value: Boolean(tool.keepSelected) },
  ];
  if (opts) fields.push({ key: 'fill', label: 'Fill new brush strokes', type: 'checkbox', value: Boolean(opts.fill) }, { key: 'editSelected', label: 'Edit selected paths', type: 'checkbox', value: Boolean(opts.editSelected) });
  return { fields, set: (k, v) => write({ [k]: v }) };
}

/** Settings adapters by tool id: tool -> { fields, set(key, value) }. Fields use the dialog field format. */
const ADAPTERS = {
  pencil: freehandSettings,
  paintbrush: freehandSettings,
  'blob-brush': (t) => ({ fields: [{ key: 'size', label: 'Size', type: 'length', value: t.size, min: 0.5, max: 1000 }], set: (k, v) => (t.size = v) }),
  eraser: (t) => ({ fields: [{ key: 'size', label: 'Size', type: 'length', value: t.size, min: 0.5, max: 1000 }], set: (k, v) => (t.size = v) }),
  rectangle: (t) => clickSize(t, 'lastRect'),
  ellipse: (t) => clickSize(t, 'lastEllipse'),
  'rounded-rectangle': (t) => {
    const base = clickSize(t, 'lastRect');
    return {
      fields: [...base.fields, { key: 'r', label: 'Corner Radius', type: 'length', value: t.radius, min: 0 }],
      set: (k, v) => (k === 'r' ? (t.radius = v) : base.set(k, v)),
    };
  },
  polygon: (t) => ({ fields: [{ key: 'sides', label: 'Sides', type: 'number', value: t.sides, min: 3, max: 1000, step: 1 }], set: (k, v) => (t.sides = Math.round(v)) }),
  star: (t) => ({ fields: [{ key: 'points', label: 'Points', type: 'number', value: t.points, min: 3, max: 1000, step: 1 }], set: (k, v) => (t.points = Math.round(v)) }),
};

/** Width and height a click on the canvas offers (and the size dialog remembers). */
function clickSize(tool, pref) {
  const last = tool.app.prefs.get(pref) || { w: 100, h: 100 };
  return {
    fields: [
      { key: 'w', label: 'Width', type: 'length', value: last.w, min: 0.01 },
      { key: 'h', label: 'Height', type: 'length', value: last.h, min: 0.01 },
    ],
    set: (k, v) => tool.app.prefs.set(pref, { ...(tool.app.prefs.get(pref) || { w: 100, h: 100 }), [k]: v }),
  };
}

/** Tools whose options live in preferences (`optionFields`, `readOptions`, `setOptions`). */
function optionSettings(tool) {
  const fields = tool.optionFields();
  return {
    fields,
    set: (k, v) => {
      const values = Object.fromEntries(tool.optionFields().filter((f) => f.key).map((f) => [f.key, f.value]));
      values[k] = v;
      tool.setOptions(tool.readOptions(values));
    },
  };
}

/** The settings for the active tool, or null when it has none here. */
export function toolSettings(app) {
  const tool = app.tool;
  if (!tool) return null;
  const adapter = ADAPTERS[app.toolId];
  if (adapter) return adapter(tool);
  if (typeof tool.optionFields === 'function' && typeof tool.setOptions === 'function') return optionSettings(tool);
  return null;
}

/** One control for a dialog-format field: { el, set(value) }. */
function control(f, unit, onChange) {
  if (f.type === 'checkbox') {
    const id = nextId();
    const input = h('input', { type: 'checkbox', id, checked: Boolean(f.value), onchange: () => onChange(input.checked) });
    return { el: h('div.check-row', input, h('label', { for: id }, f.label)), set: (v) => (input.checked = Boolean(v)) };
  }
  if (f.type === 'radio') {
    const seg = segmented(f.label, f.options.map((o) => ({ value: o.value, label: o.label, text: o.label })), f.value, (v) => {
      seg.set(v);
      onChange(v);
    });
    return { el: h('div.prop-row', h('span.prop-label', f.label), seg.el), set: (v) => seg.set(v) };
  }
  if (f.type === 'range') {
    const id = nextId();
    const out = h('output', { for: id }, String(f.value));
    const input = h('input', { type: 'range', id, min: f.min ?? 0, max: f.max ?? 100, step: f.step ?? 1, value: f.value, 'aria-label': f.hint ? `${f.label} (${f.hint})` : f.label });
    input.addEventListener('input', () => (out.textContent = input.value));
    input.addEventListener('change', () => onChange(Number(input.value)));
    return {
      el: h('div.tool-range', h('label', { for: id }, f.label), input, out),
      set: (v) => {
        if (document.activeElement === input) return;
        input.value = v;
        out.textContent = String(v);
      },
    };
  }
  const kind = f.type === 'length' ? 'length' : f.type === 'angle' ? 'angle' : f.type === 'percent' ? 'percent' : 'number';
  const nf = numberField({ label: f.label, ariaLabel: f.label, kind, unit: kind === 'length' ? unit : undefined, value: f.value, min: f.min ?? -Infinity, max: f.max ?? Infinity, step: f.step ?? 1, onCommit: (v) => onChange(v) });
  return { el: nf.el, set: (v) => nf.set(v) };
}

/** Brush for new Paintbrush strokes (the brush the Brushes panel has current). */
function brushRow(app) {
  const sel = h('select.select', { 'aria-label': 'Brush', onchange: () => (brushState(app).currentId = sel.value || null) });
  let key = null;
  return {
    el: h('div.prop-row.tool-brush', h('span.prop-label', 'Brush'), sel),
    refresh() {
      const doc = app.editor?.doc;
      if (!doc) return;
      const list = docBrushes(doc);
      if (key !== list) {
        key = list;
        const groups = Object.keys(BRUSH_TYPES)
          .map((t) => [t, list.filter((b) => b.type === t)])
          .filter(([, bs]) => bs.length)
          .map(([t, bs]) => h('optgroup', { label: BRUSH_TYPES[t].label }, bs.map((b) => h('option', { value: b.id }, b.name))));
        sel.replaceChildren(h('option', { value: '' }, 'Basic stroke (no brush)'), ...groups);
      }
      const cur = brushState(app).currentId;
      sel.value = cur && list.some((b) => b.id === cur) ? cur : '';
    },
  };
}

export function toolSection() {
  let appRef = null;
  return {
    id: 'tool-settings',
    title: 'Tool',
    noSelection: true,
    // The Properties panel shows new-artwork appearance (and a Tool Options button) alongside.
    toolSection: true,
    when: (ed) => Boolean(appRef && !ed.selection.size && toolSettings(appRef)),
    build(app) {
      appRef = app;
      const body = h('div.tool-settings');
      const brush = brushRow(app);
      let key = null;
      let controls = [];
      const el = h('div', body, brush.el);
      return {
        el,
        refresh() {
          const s = toolSettings(app);
          const title = el.parentElement?.querySelector('.section-title');
          if (title) title.textContent = app.tool?.constructor.label || 'Tool';
          if (!s) return;
          const unit = app.editor?.doc.root.units || 'pt';
          const k = `${app.toolId}:${unit}:${s.fields.map((f) => f.key).join(',')}`;
          if (k !== key) {
            key = k;
            controls = s.fields.filter((f) => f.key).map((f) => ({ key: f.key, c: control(f, unit, (v) => toolSettings(app)?.set(f.key, v)) }));
            body.replaceChildren(...controls.map((x) => x.c.el));
          }
          const values = Object.fromEntries(s.fields.map((f) => [f.key, f.value]));
          for (const x of controls) x.c.set(values[x.key]);
          brush.el.hidden = app.toolId !== 'paintbrush';
          if (!brush.el.hidden) brush.refresh();
        },
      };
    },
  };
}

export function install(app) {
  if (!PropertiesPanel.extraSections.some((s) => s.id === 'tool-settings')) PropertiesPanel.extraSections.push(toolSection());
}
