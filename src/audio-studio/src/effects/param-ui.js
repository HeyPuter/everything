// Generated parameter controls for effect and generator dialogs.
//
//   number  label | slider with a tick-marked scale (labels above) | value
//           The value is scrubbable hot text (number in the accent colour,
//           unit after it): drag sideways, click to type, arrows to step,
//           double-click to reset. Double-clicking the slider also resets.
//   bool    checkbox; a bool whose label matches its section's title becomes
//           the section's on/off switch in the frame title
//   choice  radio buttons for two or three short options, else a dropdown
//   data    envelope and curve editors (editors.js)
//
// Params are grouped in titled frames by `section`. A definition's `layout`
// arranges the frames:
//   layout: {
//     columns: [['Left Channel', 'Right Channel'], ['Echo Equalizer']], // side-by-side columns
//     vertical: ['Bands'],         // sections drawn as a row of vertical sliders (graphic EQ)
//     knobs: ['Compressor'],       // sections drawn as a grid of rotary knobs (Dynamics)
//     collapsed: ['Advanced'],     // sections in a collapsible disclosure, closed at first
//     tabs: [{ label: 'Dynamics', sections: [...], editor: true }, ...] // tabbed pages (dialog.js)
//     meters: { Compressor: [{ index: 1, label: 'Reduction', kind: 'gr' }] } // live readout meters
//     table: {                     // sections as the columns of a compact table (EQ bands)
//       columns: [{ section: 'Band 1', label: '1' }, ...],
//       rows: [{ label: 'Frequency', suffix: ['Freq'] }, { label: 'Band', suffix: ['On'] }],
//     }                            // a cell is the column section's param whose id ends with a suffix
//     order: [null, 'Advanced'],   // frame order (null = params outside any section)
//     wide: true                   // a wider dialog
//   }
// Per param: `ends: ['Dry', 'Wet']` labels the slider's ends; `enabledIf(values)`
// greys a control out while it has no effect; `control: 'select' | 'radio'`
// overrides the choice rendering (and shows a whole-number param as a
// dropdown); `short` is a compact label for vertical sliders and knobs;
// `order` moves a param within its frame.

import { h } from '../lib/dom.js';
import { hotNumber, select, knob } from '../ui/controls.js';
import { icon } from '../ui/icons.js';
import { paramType, toPosition, fromPosition, formatValue, formatParts, parseValue, coerce, scaleTicks } from './params.js';
import { envelopeControl, curveControl } from './editors.js';
import { meterStrip } from './meters-ui.js';

let uid = 0;

const asRadio = (p) => p.control === 'radio' || (p.control !== 'select' && (p.options || []).length <= 3 && (p.options || []).every((o) => String(o.label).length <= 14));

/** The tick ruler drawn above (or beside) a slider. */
function ruler(p, vertical = false) {
  const { major, minor } = scaleTicks(p, { maxLabels: vertical ? 5 : 7 });
  const side = vertical ? 'bottom' : 'left';
  const at = (x) => ({ [side]: `${(x * 100).toFixed(3)}%` });
  return h(
    `div.fx-ruler${vertical ? '.v' : ''}`,
    { 'aria-hidden': 'true' },
    minor.map((x) => h('span.fx-tick', { style: at(x) })),
    major.map((t) => h('span.fx-tick.major', { style: at(t.x) })),
    vertical ? null : major.map((t) => h('span.fx-tick-label', { style: at(t.x) }, t.label)),
  );
}

/** A number control: { slider, value, el: [slider wrapper], show(values), setDisabled(bool) }. */
function numberControl(p, getValues, onSet, { vertical = false } = {}) {
  const label = p.label || p.id;
  const log = p.scale === 'log' && p.min > 0;
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  const step = p.step || (max - min) / 1000;
  const slider = h('input.slider.fx-slider', {
    type: 'range',
    min: log ? 0 : min,
    max: log ? 1000 : max,
    step: log ? 1 : step,
    'aria-label': label,
    oninput: () => onSet(p.id, log ? fromPosition(p, Number(slider.value) / 1000) : Number(slider.value)),
    ondblclick: () => onSet(p.id, p.default),
  });
  if (vertical) slider.setAttribute('aria-orientation', 'vertical');
  const parts = (v) => formatParts(p, v);
  const editText = (v) => {
    const [n, u] = formatParts(p, v);
    return !u || u === (p.unit || '') ? n : `${n} ${u}`;
  };
  // A log value is scrubbed as a slider position snapped to 0.0025; a typed
  // value is kept as typed instead of snapping to the nearest position.
  let typed = null;
  const hot = log
    ? hotNumber({
        value: toPosition(p, getValues()[p.id]),
        min: 0,
        max: 1,
        step: 0.0025,
        label,
        pixelsPerStep: 0.75,
        format: (x) => formatValue(p, fromPosition(p, x)),
        parts: (x) => parts(fromPosition(p, x)),
        editText: (x) => editText(fromPosition(p, x)),
        parse: (s) => {
          typed = parseValue(p, s);
          return toPosition(p, typed);
        },
        onInput: (x) => onSet(p.id, fromPosition(p, x)),
        onChange: (x) => {
          const v = Number.isFinite(typed) ? typed : fromPosition(p, x);
          typed = null;
          onSet(p.id, v);
          // Typing the current value changes nothing, so show it again unsnapped.
          hot.setValue(toPosition(p, getValues()[p.id]));
        },
        defaultValue: toPosition(p, p.default),
      })
    : hotNumber({
        value: getValues()[p.id],
        min,
        max,
        step,
        label,
        pixelsPerStep: Math.max(0.01, (240 * step) / (max - min || 1)),
        format: (x) => formatValue(p, x),
        parts,
        editText,
        parse: (s) => parseValue(p, s),
        onInput: (x) => onSet(p.id, x),
        onChange: (x) => onSet(p.id, x),
        defaultValue: p.default,
      });
  hot.title = 'Drag to change, click to type, double-click to reset';
  const ends = p.ends ? h('div.fx-ends', { 'aria-hidden': 'true' }, h('span', p.ends[0]), h('span', p.ends[1])) : null;
  const wrap = h(`div.fx-scale${vertical ? '.v' : ''}`, ruler(p, vertical), slider, ends);
  const show = (v) => {
    const val = v[p.id];
    slider.value = String(log ? Math.round(toPosition(p, val) * 1000) : val);
    slider.setAttribute('aria-valuetext', formatValue(p, val));
    hot.setValue(log ? toPosition(p, val) : val);
  };
  show(getValues());
  const setDisabled = (off) => {
    slider.disabled = off;
    hot.disabled = off;
  };
  return { wrap, slider, hot, show, setDisabled };
}

function radioGroup(p, getValues, onSet) {
  const name = `fx-radio-${++uid}`;
  const inputs = (p.options || []).map((o) => {
    const input = h('input', { type: 'radio', name, value: String(o.value), onchange: () => input.checked && onSet(p.id, coerce(p, o.value)) });
    return { o, input, el: h('label.fx-radio', input, h('span', o.label)) };
  });
  const el = h('div.fx-radios', { role: 'radiogroup', 'aria-label': p.label || p.id }, inputs.map((x) => x.el));
  const show = (v) => inputs.forEach(({ o, input }) => (input.checked = String(o.value) === String(v[p.id])));
  show(getValues());
  return { el, show, setDisabled: (off) => inputs.forEach(({ input }) => (input.disabled = off)) };
}

/**
 * One param's control. Returns { cells: [label, control, value?], kind, show(values, from), setDisabled }.
 * `cells` fill a three-column grid row (kind 'row') or span it (kind 'wide').
 */
export function paramControl(p, getValues, onSet, { doc = null, range = null, smooth } = {}) {
  const type = paramType(p);
  const label = p.label || p.id;
  if (type === 'bool') {
    const box = h('input', { type: 'checkbox', checked: Boolean(getValues()[p.id]), onchange: () => onSet(p.id, box.checked) });
    return { kind: 'bool', cells: [h('label.check.fx-bool', box, h('span', label))], show: (v) => (box.checked = Boolean(v[p.id])), setDisabled: (off) => (box.disabled = off) };
  }
  if (type === 'choice') {
    if (asRadio(p)) {
      const r = radioGroup(p, getValues, onSet);
      return { kind: 'row', cells: [h('span.fx-label', `${label}:`), h('div.fx-choice', r.el)], show: r.show, setDisabled: r.setDisabled };
    }
    const sel = select({ value: getValues()[p.id], options: p.options || [], label, onChange: (val) => onSet(p.id, coerce(p, val)) });
    return { kind: 'row', cells: [h('label.fx-label', `${label}:`), h('div.fx-choice', sel)], show: (v) => (sel.value = String(v[p.id])), setDisabled: (off) => (sel.disabled = off) };
  }
  if (type === 'curve' || type === 'envelope') {
    const smoothNow = () => Boolean(smooth?.(getValues()));
    const env =
      type === 'curve'
        ? curveControl({ param: p, value: getValues()[p.id], onChange: (points) => onSet(p.id, points), smooth: smoothNow })
        : envelopeControl({ param: p, value: getValues()[p.id], onChange: (points) => onSet(p.id, points), doc, range, smooth: smoothNow });
    const show = (v, from) => {
      if (from !== p.id) env.setPoints(v[p.id]);
      else env.redraw();
    };
    const reset = h('button.icon-btn.fx-reset', { type: 'button', 'aria-label': `Reset ${label.toLowerCase()}`, title: `Reset ${label.toLowerCase()}`, onclick: () => onSet(p.id, structuredClone(p.default)) }, icon('rotate-ccw', 14));
    return { kind: 'wide', cells: [h('div.fx-envelope-row', h('div.fx-envelope-head', h('div.fx-label', label), reset), env)], show, setDisabled: () => {} };
  }
  if (p.control === 'select') {
    // A small whole-number range as a dropdown (voices, stages).
    const options = [];
    for (let v = p.min ?? 0; v <= (p.max ?? 0); v += p.step || 1) options.push({ value: v, label: String(v) });
    const sel = select({ value: getValues()[p.id], options, label, onChange: (val) => onSet(p.id, Number(val)) });
    return { kind: 'row', cells: [h('label.fx-label', `${label}:`), h('div.fx-choice', sel)], show: (v) => (sel.value = String(v[p.id])), setDisabled: (off) => (sel.disabled = off) };
  }
  const c = numberControl(p, getValues, onSet);
  const lab = h('label.fx-label', { onclick: () => c.hot.focus() }, `${label}:`);
  return { kind: 'row', cells: [lab, c.wrap, h('div.fx-value', c.hot)], show: c.show, setDisabled: c.setDisabled };
}

/** A vertical slider column (graphic EQ band): short label, slider with ruler, value. */
function verticalControl(p, getValues, onSet) {
  const c = numberControl(p, getValues, onSet, { vertical: true });
  const el = h('div.fx-vslider', h('div.fx-vlabel', p.short || p.label || p.id), c.wrap, h('div.fx-value', c.hot));
  return { el, show: c.show, setDisabled: c.setDisabled };
}

/** A rotary knob cell: knob, value, label (positions map log params like the sliders). */
function knobControl(p, getValues, onSet) {
  const label = p.short || p.label || p.id;
  const c = numberControl(p, getValues, onSet);
  const k = knob({
    value: toPosition(p, getValues()[p.id]),
    min: 0,
    max: 1,
    step: 0.002,
    defaultValue: toPosition(p, p.default),
    label: p.label || p.id,
    size: 40,
    format: (x) => formatValue(p, fromPosition(p, x)),
    onInput: (x) => onSet(p.id, fromPosition(p, x)),
    onChange: (x) => onSet(p.id, fromPosition(p, x)),
  });
  const el = h('div.fx-knob', k, h('div.fx-value', c.hot), h('div.fx-knob-label', label));
  const show = (v) => {
    c.show(v);
    k.setValue(toPosition(p, v[p.id]));
  };
  return { el, show, setDisabled: (off) => {
    c.setDisabled(off);
    k.disabled = off;
  } };
}

/** Params grouped by section, in first-appearance order: [{ name, params }]. */
export function sectionGroups(params) {
  const groups = new Map();
  for (const p of params) {
    if (p.hidden) continue;
    const name = p.section || null;
    if (!groups.has(name)) groups.set(name, { name, params: [] });
    groups.get(name).params.push(p);
  }
  // `order` moves a param within its frame (WASM index order stays as declared).
  for (const g of groups.values()) g.params = g.params.map((p, i) => ({ p, k: (p.order ?? 0) * 1000 + i })).sort((a, b) => a.k - b.k).map((x) => x.p);
  return [...groups.values()];
}

/**
 * Generated controls for a definition's params, framed by section and
 * arranged by `layout`. Options: params (subset), sections (names to
 * include; null stands for the unsectioned params), doc, range, smooth.
 * Returns { el, refresh(values, from) }; onSet(id, value) reports changes.
 */
export function paramControls(def, getValues, onSet, { doc = null, range = null, smooth, params = def.params, sections = null, layout = def.layout || {}, onReadout = null } = {}) {
  const refreshers = [];
  const toggles = [];
  const built = new Map();
  const tabled = new Set((layout.table?.columns || []).map((c) => c.section));
  for (const g of sectionGroups(params)) {
    if (sections && !sections.includes(g.name)) continue;
    if (tabled.has(g.name)) continue;
    built.set(g.name, buildGroup(g));
  }

  function rowsFor(list, grid) {
    for (const p of list) {
      const c = paramControl(p, getValues, onSet, { doc, range, smooth });
      if (c.kind === 'row') grid.append(h('div.fx-row', c.cells));
      else grid.append(h(`div.fx-row.${c.kind}`, c.cells));
      refreshers.push((v, from) => {
        c.show(v, from);
        if (p.enabledIf) c.setDisabled(!p.enabledIf(v));
      });
    }
  }

  function buildGroup({ name, params: list }) {
    // Live meters under the frame title (layout.meters: { section: [{ index, label, kind }] };
    // `main` holds the meters for the params outside any section).
    const meterSpecs = layout.meters?.[name ?? 'main'];
    let meters = null;
    if (meterSpecs && onReadout) {
      meters = meterStrip(meterSpecs);
      onReadout((v) => meters.feed(v));
    }
    if (!name) {
      const grid = h('div.fx-params');
      rowsFor(list, grid);
      return meters ? h('div.fx-plain', meters.el, grid) : grid;
    }
    // A bool labelled like its section switches the whole section.
    const sw = list.find((p) => paramType(p) === 'bool' && (p.label || p.id) === name);
    const rest = list.filter((p) => p !== sw);
    let title = name;
    if (sw) {
      const box = h('input', { type: 'checkbox', onchange: () => onSet(sw.id, box.checked) });
      title = h('label.check.fx-legend-check', box, h('span', name));
      toggles.push({ box, sw });
    }
    if ((layout.vertical || []).includes(name)) {
      const strip = h('div.fx-vsliders');
      for (const p of rest) {
        if (paramType(p) !== 'number') continue;
        const c = verticalControl(p, getValues, onSet);
        strip.append(c.el);
        refreshers.push((v) => {
          c.show(v);
          if (p.enabledIf) c.setDisabled(!p.enabledIf(v));
        });
      }
      const others = rest.filter((p) => paramType(p) !== 'number');
      const grid = h('div.fx-params');
      rowsFor(others, grid);
      return h('fieldset.fx-group.fx-vgroup', { dataset: { section: name } }, h('legend', title), meters?.el, strip, others.length ? grid : null);
    }
    if ((layout.knobs || []).includes(name)) {
      const knobs = h('div.fx-knobs');
      const others = [];
      for (const p of rest) {
        if (paramType(p) !== 'number') {
          others.push(p);
          continue;
        }
        const c = knobControl(p, getValues, onSet);
        knobs.append(c.el);
        refreshers.push((v) => {
          c.show(v);
          if (p.enabledIf) c.setDisabled(!p.enabledIf(v));
        });
      }
      const grid = h('div.fx-params');
      rowsFor(others, grid);
      return h('fieldset.fx-group.fx-knobgroup', { dataset: { section: name } }, h('legend', title), meters?.el, others.length ? grid : null, knobs);
    }
    const grid = h('div.fx-params');
    rowsFor(rest, grid);
    if ((layout.collapsed || []).includes(name)) {
      return h('details.fx-group.fx-collapsible', { dataset: { section: name } }, h('summary', title), meters?.el, grid);
    }
    return h('fieldset.fx-group', { dataset: { section: name } }, h('legend', title), meters?.el, grid);
  }

  // Band table: one column per section, one row per param role.
  let table = null;
  if (layout.table && layout.table.columns.some((c) => params.some((p) => p.section === c.section && !p.hidden))) {
    const t = layout.table;
    // Params a custom view lays out itself are hidden; a table of none is left out.
    const inSection = (sec) => params.filter((p) => p.section === sec && !p.hidden);
    const cols = t.columns.filter((c) => (!sections || sections.includes(c.section)) && inSection(c.section).length);
    const cells = [h('span.fx-table-corner')];
    for (const c of cols) cells.push(h('span.fx-table-head', c.label));
    for (const row of t.rows) {
      cells.push(h('span.fx-label.fx-table-row', row.label));
      for (const c of cols) {
        const p = inSection(c.section).find((q) => row.suffix.some((sfx) => q.id.endsWith(sfx)));
        if (!p) {
          cells.push(h('span.fx-table-cell'));
          continue;
        }
        const type = paramType(p);
        let el;
        let show;
        let setDisabled;
        if (type === 'bool') {
          el = h('button.fx-band-toggle', { type: 'button', 'aria-label': `${c.section} on`, title: `Turn ${c.section} on or off`, onclick: () => onSet(p.id, !getValues()[p.id]) }, c.label);
          show = (v) => el.setAttribute('aria-pressed', String(Boolean(v[p.id])));
          setDisabled = (off) => (el.disabled = off);
        } else if (type === 'choice') {
          el = select({ value: getValues()[p.id], options: p.options || [], label: `${c.section} ${p.label || p.id}`, onChange: (val) => onSet(p.id, coerce(p, val)) });
          show = (v) => (el.value = String(v[p.id]));
          setDisabled = (off) => (el.disabled = off);
        } else {
          const n = numberControl({ ...p, label: `${c.section} ${p.label || p.id}` }, getValues, onSet);
          el = n.hot;
          show = n.show;
          setDisabled = n.setDisabled;
        }
        cells.push(h('span.fx-table-cell', { dataset: { section: c.section } }, el));
        refreshers.push((v) => {
          show(v);
          if (p.enabledIf) setDisabled(!p.enabledIf(v));
        });
      }
    }
    table = h('div.fx-table', { role: 'group', 'aria-label': t.label || 'Bands', style: { '--cols': String(cols.length) } }, cells);
  }

  const el = h('div.fx-controls', table);
  const placed = new Set();
  const cols = (layout.columns || []).map((names) => names.filter((n) => built.has(n)));
  if (cols.some((c) => c.length)) {
    el.append(
      h(
        'div.fx-columns',
        { style: { '--cols': String(cols.length) } },
        cols.map((names) =>
          h(
            'div.fx-column',
            names.map((n) => {
              placed.add(n);
              return built.get(n);
            }),
          ),
        ),
      ),
    );
  }
  // layout.order lists frames (null = the unsectioned params) to show in that order.
  const order = layout.order || [];
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  [...built.entries()].map(([name, node], i) => ({ name, node, k: rank(name) * 1000 + i })).sort((a, b) => a.k - b.k).forEach(({ name, node }) => !placed.has(name) && el.append(node));

  const refresh = (values, from) => {
    refreshers.forEach((f) => f(values, from));
    for (const { box, sw } of toggles) {
      box.checked = Boolean(values[sw.id]);
      box.closest('.fx-group')?.classList.toggle('off', !box.checked);
    }
  };
  refresh(getValues(), null);
  return { el, refresh };
}
