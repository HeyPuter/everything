/**
 * Dialogs: new project, type editor (with layer structure), visibility,
 * project information, units, materials, levels, types, snaps, purge,
 * schedules, sheets, sharing, export, command search, shortcuts and help.
 */
import { h, clear, MOD } from './dom.js';
import { icon, KIND_ICON } from './icons.js';
import { openDialog, toast, confirmDialog, promptDialog } from './dialog.js';
import { COMMANDS } from '../commands.js';
import { CATEGORIES, KIND_LABEL, typeThickness, FAMILY_BY_KIND } from '../core/catalog.js';
import { TYPE_PARAMS } from '../core/props.js';
import { formatLength, parseLength, MM_PER_FOOT } from '../core/units.js';
import { uniqueName, deleteElements } from '../core/ops.js';
import { planView } from '../core/template.js';
import { newId, isView } from '../core/doc.js';
import { SCHEDULE_CATEGORIES } from '../core/schedule.js';
import { sheetSize } from '../core/sheet.js';
import { bboxUnion } from '../core/geom.js';
import { createLevel } from '../editor/draw.js';
import * as exporters from '../io/exporters.js';
import { isSignedIn, puterAvailable } from '../platform.js';

const field = (label, control, hint) => h('label.field', h('span.field-label', label), control, hint ? h('span.field-hint', hint) : null);

function lengthInput(app, value, label) {
  const input = h('input.input', { type: 'text', value: formatLength(value ?? 0, app.doc.units), 'aria-label': label, spellcheck: 'false' });
  input.read = () => parseLength(input.value, app.doc.units);
  return input;
}

// New project ------------------------------------------------------------------------------

export async function newProjectDialog(app) {
  const pick = await openDialog({
    title: 'New Project',
    size: 'sm',
    body: h(
      'div.open-sources',
      h('button.btn.big', { type: 'button', onClick: () => document.querySelector('dialog[open]')._close('metric') }, icon('file-plus', 22), h('span', h('strong', 'Metric'), h('small', 'Millimetres; plans at 1 : 100'))),
      h('button.btn.big', { type: 'button', onClick: () => document.querySelector('dialog[open]')._close('imperial') }, icon('file-plus', 22), h('span', h('strong', 'Imperial'), h('small', 'Feet and inches; plans at 1/8" = 1\'-0"'))),
      h('button.btn.big', { type: 'button', onClick: () => document.querySelector('dialog[open]')._close('sample') }, icon('house', 22), h('span', h('strong', 'Sample house'), h('small', 'A furnished single-storey house to explore'))),
    ),
    actions: [{ label: 'Cancel', value: null }],
  });
  if (pick) await app.startProject(pick);
}

// Levels ----------------------------------------------------------------------------------------

export async function addLevelDialog(app) {
  const lv = app.doc.levels();
  const top = lv.at(-1);
  const step = app.doc.units.system === 'imperial' ? 10 * MM_PER_FOOT : 3000;
  const name = h('input.input', { type: 'text', value: uniqueName(lv.map((l) => l.name), `Level ${lv.length + 1}`) });
  const elev = lengthInput(app, (top?.elevation ?? -step) + step, 'Elevation');
  const err = h('p.field-error', { role: 'alert' });
  let result = null;
  await openDialog({
    title: 'Add Level',
    size: 'sm',
    body: h('div', field('Name', name), field('Elevation', elev, 'Floor and ceiling plans are created for the new level.'), err),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Add Level',
        primary: true,
        onClick: () => {
          const e = elev.read();
          if (!Number.isFinite(e)) {
            err.textContent = 'Enter a valid elevation.';
            return false;
          }
          result = { name: name.value.trim() || undefined, elevation: e };
          return true;
        },
      },
    ],
  });
  return result;
}

export function levelsDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    const table = h('table.layers-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Elevation'), h('th', ''))));
    const tb = h('tbody');
    for (const l of doc.levels()) {
      const name = h('input.input', { type: 'text', value: l.name, 'aria-label': 'Level name' });
      name.addEventListener('change', () => name.value.trim() && app.commit('Rename level', () => doc.update(l.id, { name: name.value.trim() })));
      const elev = lengthInput(app, l.elevation, 'Elevation');
      elev.addEventListener('change', () => {
        const v = elev.read();
        if (Number.isFinite(v)) app.commit('Level elevation', () => doc.update(l.id, { elevation: v }));
        else elev.value = formatLength(l.elevation, doc.units);
      });
      const del = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${l.name}`, 'data-tip': 'Delete level', disabled: doc.count('level') <= 1, onClick: async () => {
        const n = doc.filter((e) => e.levelId === l.id).length;
        if (await confirmDialog('Delete level', `Delete ${l.name}? Its ${n} elements and its views are deleted too.`, { confirm: 'Delete', danger: true })) {
          app.commit('Delete level', () => deleteElements(doc, [l.id]));
          render();
        }
      } }, icon('trash', 15));
      tb.append(h('tr', h('td', name), h('td', elev), h('td', del)));
    }
    table.append(tb);
    body.append(table, h('div', { style: { marginTop: '10px' } }, h('button.btn.sm', { type: 'button', onClick: async () => {
      const r = await addLevelDialog(app);
      if (r) createLevel(app, r.elevation, r.name);
      render();
    } }, icon('plus', 14), 'Add Level')));
  };
  render();
  return openDialog({ title: 'Levels', body, size: 'md', actions: [{ label: 'Close', primary: true, value: null }] });
}

// Type editor ---------------------------------------------------------------------------------

export function typeDialog(app, type) {
  const doc = app.doc;
  let t = doc.get(type.id) || type;
  const body = h('div');
  const params = TYPE_PARAMS[t.kind] || [];
  const render = () => {
    t = doc.get(t.id);
    clear(body);
    const fam = t.familyName || FAMILY_BY_KIND[t.kind] || '';
    const typeSel = h('select.input', { 'aria-label': 'Type' });
    for (const x of doc.all(t.kind)) if ((x.familyName || '') === (t.familyName || '')) typeSel.append(h('option', { value: x.id, selected: x.id === t.id }, x.name));
    typeSel.addEventListener('change', () => {
      t = doc.get(typeSel.value);
      render();
    });
    const head = h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', alignItems: 'end', marginBottom: '12px' } },
      field(`Family: ${fam}`, typeSel),
      h('button.btn', { type: 'button', onClick: async () => {
        const name = await promptDialog('Duplicate Type', 'Name', uniqueName(doc.all(t.kind).map((x) => x.name), `${t.name} 2`));
        if (!name) return;
        const { id: _id, ...rest } = t;
        void _id;
        let c;
        app.commit('Duplicate type', () => (c = doc.add({ ...rest, name })));
        t = c;
        render();
      } }, 'Duplicate...'),
      h('button.btn', { type: 'button', onClick: async () => {
        const name = await promptDialog('Rename Type', 'Name', t.name);
        if (name) app.commit('Rename type', () => doc.update(t.id, { name }));
        render();
      } }, 'Rename...'),
    );
    body.append(head);
    const used = doc.filter((e) => e.typeId === t.id).length;
    body.append(h('p.field-hint', { style: { marginBottom: '8px' } }, `${used} element${used === 1 ? '' : 's'} in the project use${used === 1 ? 's' : ''} this type. Changes apply to all of them.`));
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(140px, 40%) 1fr', gap: '6px 12px', alignItems: 'center' } });
    for (const p of params) {
      if (p.type === 'button' && p.action === 'edit-layers') continue;
      const label = h('span', { style: { fontSize: 'var(--fs-sm)' } }, p.label);
      let control;
      const v = p.get ? p.get(t, { doc }) : t[p.key];
      const set = (val) => app.commit(`Edit type: ${p.label}`, () => doc.update(t.id, { [p.key]: val }));
      if (p.type === 'readonly') control = h('span', { style: { color: 'var(--fg-muted)' } }, typeof v === 'number' ? formatLength(v, doc.units) : String(v ?? ''));
      else if (p.type === 'length') {
        control = lengthInput(app, v ?? 0, p.label);
        control.addEventListener('change', () => {
          const x = control.read();
          if (Number.isFinite(x) && x >= 0) set(x);
          else control.value = formatLength(v ?? 0, doc.units);
        });
      } else if (p.type === 'bool') {
        control = h('input', { type: 'checkbox', checked: !!v, 'aria-label': p.label });
        control.addEventListener('change', () => set(control.checked));
      } else if (p.type === 'select') {
        control = h('select.input', { 'aria-label': p.label }, p.options().map((o) => h('option', { value: o.value, selected: o.value === v }, o.label)));
        control.addEventListener('change', () => set(control.value));
      } else if (p.type === 'material') {
        control = h('select.input', { 'aria-label': p.label }, doc.all('material').map((m) => h('option', { value: m.id, selected: m.id === v }, m.name)));
        control.addEventListener('change', () => set(control.value));
      } else {
        control = h('input.input', { type: 'text', value: v ?? '', 'aria-label': p.label });
        control.addEventListener('change', () => set(control.value));
      }
      grid.append(label, control);
    }
    body.append(grid);
    if (t.layers) body.append(layersEditor(app, t, render));
    if (t.curtain) body.append(curtainEditor(app, t));
  };
  render();
  return openDialog({ title: 'Type Properties', body, size: 'lg', actions: [{ label: 'Close', primary: true, value: null }] });
}

const LAYER_FUNCS = [
  ['finish', 'Finish'],
  ['substrate', 'Substrate'],
  ['structure', 'Structure'],
  ['insulation', 'Thermal/Insulation'],
  ['membrane', 'Membrane'],
  ['air', 'Air Space'],
];

function layersEditor(app, t, rerender) {
  const doc = app.doc;
  const wrap = h('div', { style: { marginTop: '16px' } });
  const top = t.kind === 'wallType' ? 'Exterior side' : 'Top';
  const bottom = t.kind === 'wallType' ? 'Interior side' : 'Bottom';
  wrap.append(h('h3.dlg-sub', `Structure (total ${formatLength(typeThickness(t), doc.units)})`));
  const preview = h('canvas.layer-preview', { width: 600, height: 46, 'aria-hidden': 'true' });
  const draw = () => {
    const ctx = preview.getContext('2d');
    const W = preview.width;
    const H = preview.height;
    ctx.clearRect(0, 0, W, H);
    const total = typeThickness(t) || 1;
    let x = 0;
    for (const l of t.layers) {
      const w = (l.thickness / total) * W;
      ctx.fillStyle = doc.get(l.materialId)?.color || '#ccc';
      ctx.fillRect(x, 0, w, H);
      ctx.strokeStyle = '#333';
      ctx.strokeRect(x + 0.5, 0.5, w - 1, H - 1);
      x += w;
    }
  };
  wrap.append(preview);
  const table = h('table.layers-table', h('thead', h('tr', h('th', '#'), h('th', 'Function'), h('th', 'Material'), h('th', 'Thickness'), h('th', ''))));
  const tb = h('tbody');
  const update = (layers) => {
    app.commit('Edit structure', () => doc.update(t.id, { layers }));
    rerender();
  };
  t.layers.forEach((l, i) => {
    const fn = h('select.input', { 'aria-label': `Layer ${i + 1} function` }, LAYER_FUNCS.map(([v, lab]) => h('option', { value: v, selected: v === l.function }, lab)));
    fn.addEventListener('change', () => update(t.layers.map((x, j) => (j === i ? { ...x, function: fn.value } : x))));
    const mat = h('select.input', { 'aria-label': `Layer ${i + 1} material` }, doc.all('material').map((m) => h('option', { value: m.id, selected: m.id === l.materialId }, m.name)));
    mat.addEventListener('change', () => update(t.layers.map((x, j) => (j === i ? { ...x, materialId: mat.value } : x))));
    const th = lengthInput(app, l.thickness, `Layer ${i + 1} thickness`);
    th.addEventListener('change', () => {
      const v = th.read();
      if (Number.isFinite(v) && v > 0) update(t.layers.map((x, j) => (j === i ? { ...x, thickness: v } : x)));
      else th.value = formatLength(l.thickness, doc.units);
    });
    const actions = h(
      'div.inline',
      h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, onClick: () => {
        const a = t.layers.slice();
        [a[i - 1], a[i]] = [a[i], a[i - 1]];
        update(a);
      } }, icon('chevron-up', 14)),
      h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Move down', disabled: i === t.layers.length - 1, onClick: () => {
        const a = t.layers.slice();
        [a[i + 1], a[i]] = [a[i], a[i + 1]];
        update(a);
      } }, icon('chevron-down', 14)),
      h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Delete layer', disabled: t.layers.length <= 1, onClick: () => update(t.layers.filter((_, j) => j !== i)) }, icon('trash', 14)),
    );
    tb.append(h('tr', h('td', String(i + 1)), h('td', fn), h('td', mat), h('td', th), h('td', actions)));
  });
  table.append(tb);
  wrap.append(
    h('p.field-hint', `First row: ${top}. Last row: ${bottom}.`),
    table,
    h('div', { style: { marginTop: '8px' } }, h('button.btn.sm', { type: 'button', onClick: () => update([...t.layers, { materialId: 'mat-gypsum', thickness: app.doc.units.system === 'imperial' ? 12.7 : 13, function: 'finish' }]) }, icon('plus', 14), 'Insert Layer')),
  );
  requestAnimationFrame(draw);
  return wrap;
}

function curtainEditor(app, t) {
  const c = t.curtain || {};
  const set = (patch) => app.commit('Curtain grid', () => app.doc.update(t.id, { curtain: { ...(app.doc.get(t.id)?.curtain || {}), ...patch } }));
  const hs = lengthInput(app, c.hSpacing, 'Vertical grid spacing');
  hs.addEventListener('change', () => Number.isFinite(hs.read()) && set({ hSpacing: hs.read() }));
  const vs = lengthInput(app, c.vSpacing, 'Horizontal grid spacing');
  vs.addEventListener('change', () => Number.isFinite(vs.read()) && set({ vSpacing: vs.read() }));
  const mw = lengthInput(app, c.mullionWidth, 'Mullion width');
  mw.addEventListener('change', () => Number.isFinite(mw.read()) && set({ mullionWidth: mw.read() }));
  const md = lengthInput(app, c.mullionDepth, 'Mullion depth');
  md.addEventListener('change', () => Number.isFinite(md.read()) && set({ mullionDepth: md.read() }));
  return h('div', { style: { marginTop: '16px' } }, h('h3.dlg-sub', 'Curtain Grid'), h('div.row2', field('Panel width (along the wall)', hs), field('Panel height', vs), field('Mullion width', mw), field('Mullion depth', md)));
}

export function typesDialog(app) {
  const doc = app.doc;
  const kinds = ['wallType', 'floorType', 'roofType', 'ceilingType', 'doorType', 'windowType', 'columnType', 'beamType', 'stairType', 'railingType', 'componentType'];
  const list = h('ul.file-list', { style: { maxHeight: '420px' } });
  const kindSel = h('select.input', { 'aria-label': 'Category' }, kinds.map((k) => h('option', { value: k }, labelOfTypeKind(k))));
  const render = () => {
    clear(list);
    for (const t of doc.all(kindSel.value)) {
      const n = doc.filter((e) => e.typeId === t.id).length;
      list.append(h('li', h('button.file-item', { type: 'button', onClick: () => typeDialog(app, t) }, icon(KIND_ICON[kindFromType(t.kind)] || 'types', 16), h('span.file-name', `${t.familyName ? `${t.familyName}: ` : ''}${t.name}`), h('span.file-meta', `${n} in use`))));
    }
  };
  kindSel.addEventListener('change', render);
  render();
  return openDialog({ title: 'Types', body: h('div', field('Category', kindSel), list), size: 'md', actions: [{ label: 'Close', primary: true, value: null }] });
}

function labelOfTypeKind(k) {
  const kind = kindFromType(k);
  return { component: 'Components (furniture, fixtures, equipment)' }[kind] || `${KIND_LABEL[kind] || kind}s`;
}

function kindFromType(k) {
  return k.replace(/Type$/, '');
}

// Visibility ----------------------------------------------------------------------------------------

export function visibilityDialog(app) {
  const view = app.activeView;
  if (!view || !isView(view) || view.kind === 'schedule') return toast('Open a view first.', { kind: 'error' });
  const hidden = new Set(view.hiddenCats || []);
  const groups = [
    { title: 'Model categories', cats: CATEGORIES.filter((c) => c.model) },
    { title: 'Annotation and other categories', cats: CATEGORIES.filter((c) => !c.model) },
  ];
  const body = h('div');
  for (const g of groups) {
    body.append(h('h3.dlg-sub', g.title));
    const grid = h('div.snap-grid');
    for (const c of g.cats) {
      const cb = h('input', { type: 'checkbox', checked: !hidden.has(c.id) });
      cb.addEventListener('change', () => (cb.checked ? hidden.delete(c.id) : hidden.add(c.id)));
      grid.append(h('label.check', cb, c.label));
    }
    body.append(grid);
  }
  const hiddenIds = view.hiddenIds || [];
  let clearIds = false;
  if (hiddenIds.length) {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => (clearIds = cb.checked));
    body.append(h('h3.dlg-sub', 'Hidden elements'), h('label.check', cb, `Show the ${hiddenIds.length} element${hiddenIds.length === 1 ? '' : 's'} hidden individually in this view`));
  }
  return openDialog({
    title: `Visibility/Graphics: ${view.name}`,
    body,
    size: 'md',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: () => app.commit('Visibility/Graphics', () => app.doc.update(view.id, { hiddenCats: [...hidden], ...(clearIds ? { hiddenIds: [] } : {}) })) },
    ],
  });
}

// Project ----------------------------------------------------------------------------------------------

export function projectInfoDialog(app) {
  const p = app.doc.project;
  const fields = [
    ['name', 'Project name'],
    ['number', 'Project number'],
    ['client', 'Client'],
    ['address', 'Address'],
    ['author', 'Author'],
    ['status', 'Status'],
  ];
  const inputs = {};
  const body = h('div.row2', fields.map(([k, l]) => field(l, (inputs[k] = h('input.input', { type: 'text', value: p[k] || '' })))));
  return openDialog({
    title: 'Project Information',
    body,
    size: 'md',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          const patch = {};
          for (const [k] of fields) patch[k] = inputs[k].value.trim();
          app.commit('Project information', () => app.doc.update('project', patch));
          app.updateTitle();
        },
      },
    ],
  });
}

export function unitsDialog(app) {
  const u = { ...app.doc.units };
  const sys = h('select.input', {}, h('option', { value: 'metric' }, 'Metric'), h('option', { value: 'imperial' }, 'Imperial (feet and inches)'));
  sys.value = u.system;
  const metric = h('select.input', {}, h('option', { value: 'mm' }, 'Millimetres'), h('option', { value: 'cm' }, 'Centimetres'), h('option', { value: 'm' }, 'Metres'));
  metric.value = u.metric || 'mm';
  const dec = h('select.input', {}, [0, 1, 2, 3].map((d) => h('option', { value: d }, String(d))));
  dec.value = String(u.decimals || 0);
  const frac = h('select.input', {}, [2, 4, 8, 16, 32, 64].map((d) => h('option', { value: d }, `1/${d}"`)));
  frac.value = String(u.fraction || 8);
  const metricBox = h('div.row2', field('Length unit', metric), field('Decimal places', dec));
  const impBox = h('div', field('Round to the nearest', frac));
  const sync = () => {
    metricBox.hidden = sys.value !== 'metric';
    impBox.hidden = sys.value !== 'imperial';
  };
  sys.addEventListener('change', sync);
  sync();
  return openDialog({
    title: 'Project Units',
    body: h('div', field('Unit system', sys, 'Changes how lengths are shown and typed. The model itself does not change.'), metricBox, impBox),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: () => app.commit('Project units', () => app.doc.update('project', { units: { system: sys.value, metric: metric.value, decimals: +dec.value, fraction: +frac.value } })) },
    ],
  });
}

export function materialsDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    const table = h('table.layers-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Color'), h('th', 'Cut pattern'), h('th', 'Opacity'))));
    const tb = h('tbody');
    for (const m of doc.all('material')) {
      const name = h('input.input', { type: 'text', value: m.name, 'aria-label': 'Material name' });
      name.addEventListener('change', () => app.commit('Material', () => doc.update(m.id, { name: name.value })));
      const color = h('input.input', { type: 'color', value: m.color, 'aria-label': `${m.name} color` });
      color.addEventListener('change', () => app.commit('Material color', () => doc.update(m.id, { color: color.value })));
      const cut = h('select.input', { 'aria-label': `${m.name} cut pattern` }, ['none', 'solid', 'diag', 'cross', 'concrete', 'insulation', 'brick', 'wood', 'earth'].map((p) => h('option', { value: p, selected: p === m.cut }, p[0].toUpperCase() + p.slice(1))));
      cut.addEventListener('change', () => app.commit('Material pattern', () => doc.update(m.id, { cut: cut.value })));
      const op = h('input.input', { type: 'number', min: 0.05, max: 1, step: 0.05, value: m.opacity ?? 1, 'aria-label': `${m.name} opacity` });
      op.addEventListener('change', () => app.commit('Material opacity', () => doc.update(m.id, { opacity: Math.max(0.05, Math.min(1, +op.value || 1)) })));
      tb.append(h('tr', h('td', name), h('td', color), h('td', cut), h('td', op)));
    }
    table.append(tb);
    body.append(
      h('div', { style: { maxHeight: '60vh', overflow: 'auto' } }, table),
      h('div', { style: { marginTop: '8px' } }, h('button.btn.sm', { type: 'button', onClick: () => {
        app.commit('New material', () => doc.add({ kind: 'material', name: uniqueName(doc.all('material').map((x) => x.name), 'Material 1'), color: '#b0b0b0', cut: 'none', opacity: 1 }));
        render();
      } }, icon('plus', 14), 'New Material')),
    );
  };
  render();
  return openDialog({ title: 'Materials', body, size: 'lg', actions: [{ label: 'Close', primary: true, value: null }] });
}

export function snapsDialog(app) {
  const s = { ...app.settings.snaps };
  const opts = [
    ['enabled', 'Snapping on'],
    ['endpoints', 'Endpoints'],
    ['midpoints', 'Midpoints'],
    ['intersections', 'Intersections'],
    ['perpendicular', 'Perpendicular'],
    ['nearest', 'Nearest'],
    ['angles', 'Angle increments (15 degrees)'],
    ['lengths', 'Length increments'],
    ['alignment', 'Alignment with nearby points'],
  ];
  const grid = h('div.snap-grid');
  for (const [k, l] of opts) {
    const cb = h('input', { type: 'checkbox', checked: s[k] !== false });
    cb.addEventListener('change', () => (s[k] = cb.checked));
    grid.append(h('label.check', cb, l));
  }
  const labels = h('input', { type: 'checkbox', checked: app.settings.snapLabels !== false });
  return openDialog({
    title: 'Snaps',
    body: h('div', grid, h('label.check', labels, 'Show snap labels'), h('p.field-hint', 'Hold Shift while clicking to place a point without snapping or angle tracking. Hold Alt to turn object snaps off temporarily.')),
    size: 'md',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          app.settingsStore.set('snaps', s);
          app.settingsStore.set('snapLabels', labels.checked);
          app.shell.snapBtn.setAttribute('aria-pressed', String(s.enabled !== false));
        },
      },
    ],
  });
}

export async function purgeDialog(app) {
  const doc = app.doc;
  const used = new Set();
  for (const el of doc.items.values()) {
    if (el.typeId) used.add(el.typeId);
    for (const l of el.layers || []) used.add(l.materialId);
    for (const k of ['materialId', 'panelMaterialId', 'frameMaterialId']) if (el[k]) used.add(el[k]);
    if (el.curtain?.materialId) used.add(el.curtain.materialId);
  }
  const unusedTypes = doc.filter((x) => x.kind.endsWith('Type') && !used.has(x.id));
  // Keep one type per category.
  const keep = new Set();
  for (const k of new Set(unusedTypes.map((t) => t.kind))) if (!doc.all(k).some((t) => used.has(t.id))) keep.add(doc.all(k)[0].id);
  const types = unusedTypes.filter((t) => !keep.has(t.id));
  const mats = doc.all('material').filter((m) => !used.has(m.id) && m.id !== 'mat-default' && m.id !== 'mat-glass');
  if (!types.length && !mats.length) return toast('Nothing to purge: every type and material is in use.');
  const ok = await confirmDialog('Purge Unused', `Remove ${types.length} unused type${types.length === 1 ? '' : 's'} and ${mats.length} unused material${mats.length === 1 ? '' : 's'}? You can undo this.`, { confirm: 'Purge' });
  if (!ok) return;
  app.commit('Purge unused', () => [...types, ...mats].forEach((x) => doc.remove(x.id)));
  toast(`Purged ${types.length + mats.length} items.`, { kind: 'success' });
}

// Views -------------------------------------------------------------------------------------------------

export function planViewDialog(app) {
  const doc = app.doc;
  const list = h('div');
  const checks = [];
  for (const l of doc.levels()) {
    const cb = h('input', { type: 'checkbox', value: l.id });
    checks.push(cb);
    list.append(h('label.check', cb, l.name));
  }
  const kind = h('select.input', {}, h('option', { value: 'plan' }, 'Floor Plan'), h('option', { value: 'ceilingPlan' }, 'Ceiling Plan'));
  return openDialog({
    title: 'New Plan View',
    body: h('div', field('Type', kind), h('h3.dlg-sub', 'Levels'), list),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Create',
        primary: true,
        onClick: () => {
          let last;
          const names = doc.filter((x) => isView(x)).map((x) => x.name);
          app.commit('New plan view', () => {
            for (const cb of checks)
              if (cb.checked) {
                const v = planView(doc, doc.get(cb.value), kind.value);
                v.name = uniqueName(names, v.name);
                names.push(v.name);
                last = doc.add(v);
              }
          });
          if (last) app.openView(last.id);
        },
      },
    ],
  });
}

export function newScheduleDialog(app, category) {
  const sel = h('select.input', { 'aria-label': 'Category' }, Object.entries(SCHEDULE_CATEGORIES).map(([k, c]) => h('option', { value: k, selected: k === category }, c.label)));
  const name = h('input.input', { type: 'text', value: '' });
  const sync = () => (name.placeholder = `${SCHEDULE_CATEGORIES[sel.value].label.replace(/s$/, '')} Schedule`);
  sel.addEventListener('change', sync);
  sync();
  return openDialog({
    title: 'New Schedule',
    body: h('div', field('Category', sel), field('Name', name)),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Create',
        primary: true,
        onClick: () => {
          const names = app.doc.all('schedule').map((s) => s.name);
          const v = { id: newId('v'), kind: 'schedule', name: uniqueName(names, name.value.trim() || name.placeholder), category: sel.value, fields: null, sortBy: null };
          app.commit('New schedule', () => app.doc.add(v));
          app.openView(v.id);
        },
      },
    ],
  });
}

export function scheduleFieldsDialog(app, id) {
  const view = app.doc.get(id || app.activeViewId);
  if (!view || view.kind !== 'schedule') return;
  const cat = SCHEDULE_CATEGORIES[view.category];
  const current = view.fields?.length ? view.fields : cat.defaults;
  const order = [...current, ...cat.fields.map((f) => f.id).filter((f) => !current.includes(f))];
  const on = new Set(current);
  const list = h('ul.style-list', { 'aria-label': 'Fields' });
  const render = () => {
    clear(list);
    order.forEach((fid, i) => {
      const f = cat.fields.find((x) => x.id === fid);
      const cb = h('input', { type: 'checkbox', checked: on.has(fid), 'aria-label': f.label });
      cb.addEventListener('change', () => (cb.checked ? on.add(fid) : on.delete(fid)));
      list.append(
        h(
          'li.inline',
          { style: { padding: '2px 4px' } },
          h('label.check.grow', cb, f.label),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': `Move ${f.label} up`, disabled: i === 0, onClick: () => ([order[i - 1], order[i]] = [order[i], order[i - 1]], render()) }, icon('chevron-up', 14)),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': `Move ${f.label} down`, disabled: i === order.length - 1, onClick: () => ([order[i + 1], order[i]] = [order[i], order[i + 1]], render()) }, icon('chevron-down', 14)),
        ),
      );
    });
  };
  render();
  return openDialog({
    title: `Fields: ${view.name}`,
    body: list,
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: () => app.commit('Schedule fields', () => app.doc.update(view.id, { fields: order.filter((f) => on.has(f)) })) },
    ],
  });
}

export function newSheet(app) {
  const doc = app.doc;
  const sheets = doc.all('sheet');
  const num = `A${101 + sheets.length}`;
  const imp = doc.units.system === 'imperial';
  const v = { id: newId('v'), kind: 'sheet', number: num, name: 'Unnamed', size: imp ? 'ARCHD' : 'A1', drawnBy: doc.project.author || '', checkedBy: '', issueDate: new Date().toISOString().slice(0, 10) };
  app.commit('New sheet', () => doc.add(v));
  app.openView(v.id);
  toast('Sheet created. Use Place View on Sheet (View tab) to add views.');
}

export async function placeViewDialog(app, viewId) {
  const doc = app.doc;
  let sheet = app.activeView?.kind === 'sheet' ? app.activeView : null;
  const placed = new Set(doc.all('viewport').map((v) => v.placedId));
  const views = doc.filter((x) => isView(x) && !['sheet', 'schedule'].includes(x.kind) && !placed.has(x.id));
  if (!views.length) return toast('Every view is already on a sheet. A view can be placed on one sheet.', { kind: 'error' });
  const sheetSel = h('select.input', { 'aria-label': 'Sheet' }, doc.all('sheet').map((s) => h('option', { value: s.id, selected: s.id === sheet?.id }, `${s.number} - ${s.name}`)));
  if (!doc.count('sheet')) {
    newSheet(app);
    sheet = app.activeView;
    sheetSel.append(h('option', { value: sheet.id, selected: true }, `${sheet.number} - ${sheet.name}`));
  }
  const viewSel = h('select.input', { 'aria-label': 'View' }, views.map((v) => h('option', { value: v.id, selected: v.id === viewId }, `${v.name} (${{ plan: 'Floor Plan', ceilingPlan: 'Ceiling Plan', view3d: '3D', elevation: 'Elevation', section: 'Section' }[v.kind]})`)));
  const r = await openDialog({ title: 'Place View on Sheet', body: h('div', field('Sheet', sheetSel), field('View', viewSel)), size: 'sm', actions: [{ label: 'Cancel', value: null }, { label: 'Place', primary: true, value: true }] });
  if (!r) return;
  const sh = doc.get(sheetSel.value);
  const view = doc.get(viewSel.value);
  const { w, h: H } = sheetSize(sh);
  const area = { x0: 25, y0: 25, x1: w - Math.min(130, w * 0.18) - 25, y1: H - 25 };
  const at = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
  let center = null;
  let size = null;
  if (view.kind === 'plan' || view.kind === 'ceilingPlan') {
    // Center on the view's content.
    const cached = app.controllers.has(view.id);
    const c = app.controllerFor(view);
    c.sync();
    const b = c.extents();
    if (b) center = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    // Only the extents were needed; don't keep GPU layers for a view that isn't open.
    if (!cached && !app.openViews.includes(view.id)) {
      c.dispose?.();
      app.controllers.delete(view.id);
    }
  } else {
    const aw = area.x1 - area.x0;
    const ah = area.y1 - area.y0;
    size = [Math.min(aw, 260), Math.min(ah, 180)];
  }
  const n = doc.all('viewport').filter((x) => x.viewId === sh.id).length + 1;
  app.commit('Place view', () => {
    doc.add({ kind: 'viewport', viewId: sh.id, placedId: view.id, at, center, size });
    doc.update(view.id, { sheetNumber: String(n) });
  });
  app.openView(sh.id);
  toast(`${view.name} placed on ${sh.number}. Drag it to position it.`);
  void bboxUnion;
}

// Sharing ------------------------------------------------------------------------------------------------

export async function shareDialog(app) {
  if (!puterAvailable() || !(await isSignedIn().catch(() => false))) {
    const ok = await confirmDialog('Share Project', 'Sharing uses your Puter account: the project is saved to your Puter storage and shared with the people you choose. Sign in now?', { confirm: 'Sign in' });
    if (!ok || !(await app.signIn())) return;
  }
  if (app.file?.source !== 'cloud' || !app.file.path) {
    toast('Save the project to Puter first.');
    const saved = await app.saveAs();
    if (!saved || app.file?.source !== 'cloud') return;
  }
  const path = app.file.path;
  const who = h('input.input', { type: 'text', placeholder: 'Username or email', 'aria-label': 'Username or email' });
  const access = h('select.input', { 'aria-label': 'Access' }, h('option', { value: 'read' }, 'Can view'), h('option', { value: 'write' }, 'Can edit'));
  const list = h('ul.share-list');
  const status = h('p.field-hint', { role: 'status' });
  const refresh = async () => {
    clear(list);
    try {
      const shares = await puter.fs.getShares(path);
      const items = Array.isArray(shares) ? shares : shares?.items || shares?.shares || [];
      if (!items.length) list.append(h('li', h('span.grow', { style: { color: 'var(--fg-muted)' } }, 'Not shared with anyone yet.')));
      for (const s of items) {
        const name = s.username || s.user?.username || s.email || s.recipient || 'Someone';
        const mode = s.access || s.mode || s.permission || '';
        list.append(
          h(
            'li',
            icon('user', 15),
            h('span.grow', name),
            h('span.file-meta', /write|manage/.test(mode) ? 'Can edit' : 'Can view'),
            h('button.btn.sm.ghost', { type: 'button', onClick: async () => {
              await puter.fs.unshare(path, s.email ? { email: s.email } : { username: name });
              refresh();
            } }, 'Remove'),
          ),
        );
      }
    } catch (err) {
      list.append(h('li', h('span.grow', `Could not load shares: ${err.message || err}`)));
    }
  };
  const add = async () => {
    const v = who.value.trim();
    if (!v) return;
    status.textContent = 'Sharing...';
    try {
      await puter.fs.share(path, v.includes('@') ? { email: v } : { username: v }, access.value);
      status.textContent = `Shared with ${v}.`;
      who.value = '';
      refresh();
    } catch (err) {
      status.textContent = `Could not share: ${err.message || err}`;
    }
  };
  who.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
  refresh();
  return openDialog({
    title: `Share "${app.file.name}"`,
    body: h('div', h('p.dialog-text', 'People you share with open the project from Open > Shared with me. People with edit access can save changes to it.'), h('div.inline', { style: { marginTop: '12px' } }, who, access, h('button.btn.primary', { type: 'button', onClick: add }, 'Share')), status, h('h3.dlg-sub', { style: { marginTop: '14px' } }, 'People with access'), list),
    size: 'md',
    actions: [{ label: 'Done', primary: true, value: null }],
  });
}

// Export ---------------------------------------------------------------------------------------------------

export async function exportDialog(app, format) {
  const view = app.activeView;
  const formats = [
    ['pdf', 'PDF', 'Current view or sheet, vector where possible', 'printer'],
    ['png', 'PNG image', 'Current view at high resolution', 'image'],
    ['svg', 'SVG', 'Current plan or sheet as vector graphics', 'image'],
    ['dxf', 'DXF', 'Current plan as 2D lines for CAD', 'file-text'],
    ['ifc', 'IFC', 'The building model for other BIM software', 'ifc'],
    ['obj', 'OBJ', 'The 3D model as a mesh', 'view3d'],
    ['glb', 'glTF (GLB)', 'The 3D model for visualization and the web', 'view3d'],
    ['csv', 'CSV', 'The current schedule', 'schedule'],
    ['bdp', 'Project file', 'Download the project (.bdp)', 'save'],
  ];
  let pick = format;
  if (!pick) {
    pick = await openDialog({
      title: 'Export',
      size: 'md',
      body: h(
        'div.open-sources',
        { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } },
        formats.map(([id, label, sub, ic]) => h('button.btn.big', { type: 'button', disabled: id === 'csv' && view?.kind !== 'schedule', onClick: () => document.querySelector('dialog[open]')._close(id) }, icon(ic, 20), h('span', h('strong', label), h('small', sub)))),
      ),
      actions: [{ label: 'Cancel', value: null }],
    });
  }
  if (!pick) return;
  try {
    await exporters.exportAs(app, pick);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`, { kind: 'error' });
  }
}

// Command search ----------------------------------------------------------------------------------------------

export function commandPalette(app) {
  const input = h('input.input.palette-input', { type: 'search', placeholder: 'Type a command, view or shortcut', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off' });
  const list = h('ul.palette-list#palette-list', { role: 'listbox', 'aria-label': 'Results' });
  let items = [];
  let idx = 0;
  const all = () => {
    const out = Object.entries(COMMANDS)
      .filter(([, d]) => d.label && !(d.enabled && !d.enabled(app)))
      .map(([name, d]) => ({ label: d.label, icon: d.icon, hint: d.keys || d.accel || '', run: () => app.run(name) }));
    for (const v of app.doc ? app.doc.filter((x) => isView(x)) : []) out.push({ label: `Open view: ${v.name}`, icon: KIND_ICON[v.kind], hint: '', run: () => app.openView(v.id) });
    return out;
  };
  const source = all();
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = source.filter((x) => !q || x.label.toLowerCase().includes(q) || x.hint.toLowerCase() === q).slice(0, 60);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    clear(list);
    items.forEach((it, i) =>
      list.append(h('li.palette-item', { role: 'option', id: `pal-${i}`, 'aria-selected': String(i === idx), onClick: () => choose(i), onPointerenter: () => ((idx = i), mark()) }, icon(it.icon || 'search', 16), h('span.palette-label', it.label), it.hint ? h('kbd', it.hint) : null)),
    );
    input.setAttribute('aria-activedescendant', items.length ? `pal-${idx}` : '');
  };
  const mark = () => {
    for (const [i, li] of [...list.children].entries()) li.setAttribute('aria-selected', String(i === idx));
    input.setAttribute('aria-activedescendant', `pal-${idx}`);
    list.children[idx]?.scrollIntoView({ block: 'nearest' });
  };
  let close;
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    setTimeout(() => it.run(), 0);
  };
  input.addEventListener('input', () => ((idx = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(items.length - 1, idx + 1);
      mark();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(idx);
    }
  });
  render();
  const p = openDialog({ title: 'Search Commands', body: h('div', input, list), size: 'md', className: 'palette-dlg', initialFocus: 'input' });
  close = () => document.querySelector('dialog[open]')?._close?.(null);
  return p;
}

// Help -----------------------------------------------------------------------------------------------------------

export function shortcutsDialog() {
  const rows = Object.values(COMMANDS)
    .filter((d) => d.keys || d.accel)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((d) => h('div.kbd-row', h('span', d.label), h('span.inline', d.keys ? h('kbd', d.keys) : null, d.accel ? h('kbd', d.accel.replace('Ctrl', MOD)) : null)));
  return openDialog({
    title: 'Keyboard Shortcuts',
    body: h('div', h('p.dialog-text', { style: { marginBottom: '10px' } }, 'Type two-letter shortcuts in the view (no need to press Enter). Enter repeats the last tool, Esc cancels, Tab cycles overlapping elements, Space flips or rotates while placing.'), h('div.kbd-list', rows)),
    size: 'lg',
    actions: [{ label: 'Close', primary: true, value: null }],
  });
}

export function helpDialog() {
  const sec = (title, items) => [h('h3.dlg-sub', title), h('ul.help-list', items.map((t) => h('li', t)))];
  return openDialog({
    title: 'Help',
    size: 'lg',
    body: h(
      'div',
      ...sec('Getting started', [
        'Start from the Home screen with a metric or imperial project, or open the sample house.',
        'Draw walls with Wall (WA): click a start point and keep clicking; type a length to enter it exactly. Esc ends the chain.',
        'Place doors (DR) and windows (WN) by moving over a wall; they cut their own openings. Space flips them.',
        'Create floors, ceilings and roofs by picking walls or rooms, or by sketching their boundary, then click Finish.',
        'Place rooms (RM) inside enclosed areas; their area updates as walls move.',
      ]),
      ...sec('Navigation', [
        'Wheel: zoom at the cursor. Middle button drag: pan. Two-finger trackpad scroll pans; pinch zooms.',
        '3D views: right button or Shift + middle drag orbits; one finger orbits on touch screens. Use the orientation cube for standard views.',
        'Zoom to fit (ZF), zoom in region (ZR). Double-click empty space in 3D to fit.',
      ]),
      ...sec('Selecting and editing', [
        'Click to select; drag left to right for everything inside the box, right to left for everything it touches. Ctrl adds, Shift removes.',
        'Drag selected elements to move them, or use the grips. Walls joined at a corner stay joined.',
        'The Properties panel edits the selection, or the view when nothing is selected. Edit Type changes every element of a type.',
        'Modify tools: Move (MV), Copy (CO), Rotate (RO), Mirror (MM), Align (AL), Offset (OF), Trim/Extend (TR), Split (SL), Array (AR).',
      ]),
      ...sec('Views and documents', [
        'The Project Browser lists views, schedules, sheets and types. Double-click to open a view or place a type.',
        'Add sections and elevations from the View tab, then open them by double-clicking their markers.',
        'Schedules list doors, windows, rooms and more, update live and export to CSV.',
        'Sheets hold views with a title block and export to PDF.',
      ]),
      ...sec('Files', [
        'Projects are saved as .bdp files to your Puter storage or to this device. Open projects are also kept in this browser so work survives a reload.',
        'Export to IFC, OBJ and glTF for other 3D and BIM tools, DXF for CAD, and PDF, SVG or PNG for drawings.',
      ]),
    ),
    actions: [{ label: 'Close', primary: true, value: null }],
  });
}

export function aboutDialog() {
  return openDialog({
    title: 'About Building Design',
    size: 'sm',
    body: h('div', h('p.dialog-text', 'Building Design is a free, open-source building information modeling app that runs in the browser. It is in early alpha.'), h('p.dialog-text', { style: { marginTop: '8px' } }, 'Built with WebGL2 and Puter. Licensed under the MIT license.')),
    actions: [{ label: 'Close', primary: true, value: null }],
  });
}

// Phone sheets ----------------------------------------------------------------------------------------------------

function toolGrid(app, cmds, title) {
  const grid = h('div.tool-grid');
  for (const c of cmds) {
    const d = COMMANDS[c];
    if (!d) continue;
    grid.append(h('button.tool-tile', { type: 'button', disabled: d.enabled ? !d.enabled(app) : false, onClick: () => (document.querySelector('dialog[open]')?._close?.(null), setTimeout(() => app.run(c), 0)) }, icon(d.icon, 24), d.label));
  }
  return openDialog({ title, body: grid, size: 'md', className: 'sheet', actions: [] });
}

export function toolsSheet(app) {
  return toolGrid(app, ['wall', 'door', 'window', 'component', 'column', 'floor', 'roof', 'ceiling', 'stair', 'railing', 'room', 'grid', 'dimension', 'text', 'tag', 'section', 'elevation', 'view3d', 'measure', 'level'], 'Tools');
}

export function modifySheet(app) {
  return toolGrid(app, ['modify', 'move', 'copy', 'rotate', 'mirrorPick', 'align', 'offset', 'trim', 'split', 'array', 'delete', 'flip', 'editType', 'tempIsolate', 'tempReset', 'zoomFit', 'save', 'export', 'redo'], 'Modify');
}

