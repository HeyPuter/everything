// Dialogs and tool panels: equations, material, part properties, options,
// mass properties, keyboard shortcuts, about, measure, section view, and the
// sketch Offset / Mirror / Convert Entities tools.

import type { Vec3 } from '../math/vec';
import type { MassProperties } from '../kernel/protocol';
import { dist, dot, normalize, sub } from '../math/vec';
import { evaluateVariables, referencedNames, renameReferences, reservedName, variableReferenceChanges } from '../model/expr';
import { changeUnits, mapExpressions } from '../model/document';
import type { MaterialRef, SkDimension, UnitSystem, Variable } from '../model/types';
import { UNIT_SYSTEMS, formatNumber } from '../model/units';
import { BASE_FRAMES } from '../model/planes';
import { MATERIALS } from '../model/materials';
import { uniqueId } from '../model/ids';
import { mirrorAxisDirection, mirrorEntities, offsetCurves } from '../sketch/ops';
import { SketchIndex } from '../sketch/geom';
import { convertEdges } from '../sketch/convert';
import { setThemeChoice, getThemeChoice, type ThemeChoice } from '../platform/theme';
import { h, formatShortcut, isMac, nextDomId } from '../ui/dom';
import { icon } from '../ui/icons';
import { showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import { PropertyPanel, SelectionBox, type SelBoxItem, checkbox, numberField, section, selectField, segmented, settleNumberFields, retireNumberFields } from './pm';
import { type SelItem, remapItem } from './selection';
import type { MeasureTarget } from '../kernel/protocol';
import { REPO_URL } from './shell';

// ---------- equations ----------

export async function equationsDialog(app: App) {
  const signal = app.documentSignal;
  const doc = app.store.doc;
  const rows: Variable[] = structuredClone(doc.variables);
  const tbody = h('tbody');
  const err = h('div', { class: 'field-label', role: 'alert', style: { color: 'var(--danger)' } });
  // Dimensions and feature values that refer to each variable.
  const dimUses = new Map<string, number>();
  mapExpressions({ ...doc, variables: [] }, (src) => {
    for (const n of new Set(referencedNames(src.replace(/^=/, '')))) dimUses.set(n, (dimUses.get(n) ?? 0) + 1);
    return src;
  });
  const originalNames = new Map(doc.variables.map((v) => [v.id, v.name]));
  // Retain deleted IDs too: a new row must never look like a renamed old row.
  const variableIds = new Set(originalNames.keys());
  // The rows are built once (and again when one is added or deleted); an edit
  // only updates the cells it affects, so the field being left keeps its place
  // in the tab order (rebuilding them sent keyboard focus out of the dialog).
  const cells = new Map<Variable, { expr: HTMLInputElement; result: HTMLElement; del: HTMLElement }>();
  const refresh = () => {
    const { values, errors } = evaluateVariables(rows);
    for (const v of rows) {
      const c = cells.get(v)!;
      if (c.expr.value !== v.expr) c.expr.value = v.expr;
      c.expr.setAttribute('aria-label', `Value or expression of ${v.name || 'variable'}`);
      c.del.setAttribute('aria-label', `Delete ${v.name}`);
      const val = values.get(v.name);
      const e = errors.get(v.name);
      c.result.textContent = e ? e : val !== undefined ? formatNumber(val, 4) : '';
      c.result.style.color = e ? 'var(--danger)' : '';
      // The error is told to assistive tech on the field, not by colour alone.
      if (e) c.expr.setAttribute('aria-invalid', 'true');
      else c.expr.removeAttribute('aria-invalid');
    }
  };
  const draw = () => {
    tbody.textContent = '';
    cells.clear();
    rows.forEach((v, i) => {
      const name = h('input', { class: 'input', value: v.name, 'aria-label': `Name of variable ${i + 1}`, spellcheck: 'false' }) as HTMLInputElement;
      const expr = h('input', { class: 'input', value: v.expr, spellcheck: 'false' }) as HTMLInputElement;
      name.addEventListener('change', () => {
        // Other equations follow a renamed variable (dimensions and features do on OK).
        // Not from or onto a name another variable has too: its equations would be merged into this one's for good.
        const was = v.name;
        const renamed = new Map([[was, name.value.trim()]]);
        v.name = name.value.trim();
        const shared = rows.some((r) => r !== v && (r.name === was || r.name === v.name));
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) && !shared) for (const r of rows) if (r !== v) r.expr = renameReferences(r.expr, renamed);
        refresh();
      });
      expr.addEventListener('change', () => { v.expr = expr.value.trim(); refresh(); });
      const result = h('td', { class: 'num', id: nextDomId('eq-result') });
      expr.setAttribute('aria-describedby', result.id);
      const del = h('button', { class: 'icon-btn', type: 'button' }, icon('trash', 16));
      del.addEventListener('click', () => {
        rows.splice(i, 1);
        draw();
        // Focus stays in the table: on the row that moved up, else the one above, else Add variable.
        const next = tbody.querySelectorAll<HTMLButtonElement>('button')[Math.min(i, rows.length - 1)];
        (next ?? add).focus();
      });
      cells.set(v, { expr, result, del });
      tbody.append(h('tr', {},
        h('td', {}, name), h('td', {}, expr), result,
        h('td', { class: 'num' }, String(dimUses.get(originalNames.get(v.id) ?? v.name) ?? 0)),
        h('td', {}, del)));
    });
    refresh();
  };
  const add = h('button', { class: 'btn small', type: 'button' }, icon('plus', 14), 'Add variable');
  add.addEventListener('click', () => {
    let n = rows.length + 1;
    while (rows.some((r) => r.name === `Var${n}`)) n++;
    rows.push({ id: uniqueId('v', variableIds), name: `Var${n}`, expr: '10' });
    draw();
    (tbody.querySelector('tr:last-child input') as HTMLInputElement | null)?.focus();
  });
  draw();
  const v = await showDialog({
    title: 'Equations and Global Variables', signal,
    wide: true,
    body: [
      h('p', {}, `Define named values, then type "=" and a name (for example =Width/2) in any dimension or feature value to link it. Values use the part's units (${UNIT_SYSTEMS[doc.units].length}, degrees).`),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value / Equation'), h('th', {}, 'Evaluates to'), h('th', {}, 'Used by'), h('th', {}, ''))), tbody),
      add, err,
    ],
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
    onAction: (a) => {
      if (a !== 'ok') return;
      const names = rows.map((r) => r.name);
      const bad = names.find((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
      if (bad !== undefined) { err.textContent = `"${bad}" is not a valid name. Use letters, digits and underscores, starting with a letter.`; return false; }
      // Checked for new and renamed variables only, so a part saved with such a name still opens here.
      const taken = rows.find((r) => originalNames.get(r.id) !== r.name && reservedName(r.name));
      if (taken) { err.textContent = `"${taken.name}" is a constant, unit or function name. Choose another name.`; return false; }
      if (new Set(names).size !== names.length) { err.textContent = 'Variable names must be unique.'; return false; }
      const { errors } = evaluateVariables(rows);
      if (errors.size) { err.textContent = `Fix the errors first: ${[...errors].map(([k, m]) => `${k}: ${m}`).join('; ')}`; return false; }
    },
  });
  if (v === 'ok' && !signal.aborted) {
    const renamed = new Map<string, string | number>();
    for (const r of rows) {
      const was = originalNames.get(r.id);
      if (was !== undefined && was !== r.name) renamed.set(was, r.name);
    }
    // A deleted variable's dimensions and feature values keep its value instead
    // of failing on an unknown name (unless a variable of that name remains).
    const before = evaluateVariables(doc.variables).values;
    for (const [id, was] of originalNames) {
      const value = before.get(was);
      if (rows.some((r) => r.id === id || r.name === was) || value === undefined) continue;
      renamed.set(was, value);
    }
    app.store.change('Edit equations', (d) => {
      d.variables = [];
      if (renamed.size) mapExpressions(d, (src) => renameReferences(src, renamed));
      d.variables = rows;
    });
    app.sketchEditor?.resolve();
  }
}

// ---------- material ----------


export async function materialDialog(app: App) {
  const signal = app.documentSignal;
  const cur = app.store.doc.material;
  const preset = cur && MATERIALS.find((m) => m.name === cur.name && m.density === cur.density);
  const select = h('select', { class: 'input', 'aria-label': 'Material' }) as HTMLSelectElement;
  select.append(h('option', { value: '' }, 'Not specified'));
  for (const m of MATERIALS) {
    const o = h('option', { value: m.name }, `${m.name}  (${m.density} kg/m³)`) as HTMLOptionElement;
    if (preset === m) o.selected = true;
    select.append(o);
  }
  select.append(h('option', { value: '__custom' }, 'Custom...'));
  const customName = h('input', { class: 'input', value: cur && !preset ? cur.name : 'Custom material', 'aria-label': 'Custom material name' }) as HTMLInputElement;
  const customDensity = h('input', { class: 'input', type: 'number', min: '0', step: 'any', value: String(cur?.density ?? 1000), 'aria-label': 'Density in kg per cubic metre' }) as HTMLInputElement;
  const custom = h('div', { class: 'grid-form' }, h('label', {}, 'Name'), customName, h('label', {}, 'Density (kg/m³)'), customDensity);
  if (cur && !preset) select.value = '__custom';
  const error = h('div', { id: nextDomId('density-error'), class: 'field-label', role: 'alert', style: { color: 'var(--danger)' } });
  customDensity.setAttribute('aria-describedby', error.id);
  const validate = () => {
    const density = Number(customDensity.value);
    const valid = select.value !== '__custom' || (Number.isFinite(density) && density > 0);
    error.textContent = valid ? '' : 'Enter a finite, positive density.';
    if (valid) customDensity.removeAttribute('aria-invalid');
    else customDensity.setAttribute('aria-invalid', 'true');
    return valid;
  };
  customDensity.addEventListener('input', () => { if (error.textContent) validate(); });
  const sync = () => {
    custom.hidden = select.value !== '__custom';
    if (custom.hidden) validate();
  };
  select.addEventListener('change', sync);
  sync();
  const v = await showDialog({
    title: 'Material', signal,
    body: [h('p', {}, 'The material sets the density used for mass properties.'), select, custom, error],
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Apply', value: 'ok', primary: true }],
    onAction: (action) => {
      if (action === 'ok' && !validate()) { customDensity.focus(); return false; }
    },
  });
  if (v !== 'ok' || signal.aborted) return;
  let m: MaterialRef | null = null;
  if (select.value === '__custom') {
    const d = Number(customDensity.value);
    m = { name: customName.value.trim() || 'Custom material', density: d };
  } else if (select.value) m = MATERIALS.find((x) => x.name === select.value) ?? null;
  app.store.change('Edit material', (doc) => { doc.material = m; });
}

// ---------- part properties ----------

export async function propertiesDialog(app: App) {
  const signal = app.documentSignal;
  const doc = app.store.doc;
  const name = h('input', { class: 'input', value: doc.name, 'aria-label': 'Part name' }) as HTMLInputElement;
  const units = h('select', { class: 'input', 'aria-label': 'Unit system' }) as HTMLSelectElement;
  for (const u of Object.values(UNIT_SYSTEMS)) {
    const o = h('option', { value: u.id }, u.label) as HTMLOptionElement;
    if (u.id === doc.units) o.selected = true;
    units.append(o);
  }
  const decimals = h('input', { class: 'input', type: 'number', min: '0', max: '6', value: String(doc.decimals), 'aria-label': 'Decimal places' }) as HTMLInputElement;
  const v = await showDialog({
    title: 'Part Properties', signal,
    body: [h('div', { class: 'grid-form' }, h('label', {}, 'Name'), name, h('label', {}, 'Units'), units, h('label', {}, 'Decimal places'), decimals),
      h('p', { class: 'field-label' }, 'Changing units only changes how values are shown. The geometry keeps its size.')],
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
  });
  if (v !== 'ok' || signal.aborted) return;
  let unlinked: string[] = [];
  app.store.change('Part properties', (d) => {
    d.name = name.value.trim() || d.name;
    // Expressions are written in the part's units: they are converted so the geometry keeps its size.
    unlinked = changeUnits(d, units.value as UnitSystem);
    d.decimals = Math.max(0, Math.min(6, Math.round(Number(decimals.value) || 0)));
  });
  if (unlinked.length) toast({ kind: 'warning', title: 'Some equations were replaced by their values', message: `These could not be converted to the new units and keep their size as plain numbers: ${unlinked.join(', ')}.`, timeout: 9000 });
  app.sketchEditor?.render();
}

// ---------- options ----------

export async function optionsDialog(app: App) {
  const s = app.settings;
  const theme = segmented<ThemeChoice>('Theme', getThemeChoice(), [
    { value: 'system', label: 'System', icon: 'system' }, { value: 'light', label: 'Light', icon: 'light' }, { value: 'dark', label: 'Dark', icon: 'dark' },
  ], (v) => setThemeChoice(v));
  const units = selectField('Default units for new parts', s.defaultUnits, Object.values(UNIT_SYSTEMS).map((u) => ({ value: u.id, label: u.label })), (v) => app.changeSettings({ defaultUnits: v }));
  const quality = selectField('Image quality', String(s.quality) as '0' | '1' | '2', [{ value: '0', label: 'Fast (coarse tessellation)' }, { value: '1', label: 'Normal' }, { value: '2', label: 'Fine (smooth curves)' }], (v) => app.changeSettings({ quality: Number(v) }));
  const normal = checkbox('Rotate view normal to the sketch plane when editing a sketch', s.autoNormalTo, (v) => app.changeSettings({ autoNormalTo: v }));
  const zoom = checkbox('Reverse mouse wheel zoom direction', s.invertZoom, (v) => app.changeSettings({ invertZoom: v }));
  const off = app.commands.onChange(() => {
    units.querySelector('select')!.value = app.settings.defaultUnits;
    quality.querySelector('select')!.value = String(app.settings.quality);
    normal.querySelector('input')!.checked = app.settings.autoNormalTo;
    zoom.querySelector('input')!.checked = app.settings.invertZoom;
  });
  await showDialog({
    title: 'Options',
    body: [
      h('div', {}, h('div', { class: 'field-label' }, 'Theme'), theme),
      units, quality,
      normal, zoom,
    ],
    buttons: [{ label: 'Done', value: 'ok', primary: true }],
  }).finally(off);
  app.saveSettings();
}

// ---------- mass properties ----------

export async function massPropertiesDialog(app: App) {
  let replaced = false;
  const off = app.store.on((reason) => { if (reason === 'load') replaced = true; });
  let mp: MassProperties | null = null;
  try {
    for (;;) {
      await app.whenBuilt();
      if (replaced) return;
      if (!app.bbox) { toast({ kind: 'warning', message: 'There is no solid body yet.' }); return; }
      const version = app.buildVersion;
      mp = await app.kernel.massProperties().catch((e) => {
        if (!replaced) toast({ kind: 'error', message: (e as Error).message });
        return null;
      });
      if (!mp) return;
      // An edit can arrive while the kernel is calculating. Recalculate for
      // its rebuilt body; never report the old body against a new document.
      await app.whenBuilt();
      if (replaced) return;
      if (version === app.buildVersion) break;
    }
  } finally {
    off();
  }
  const doc = app.store.doc;
  const u = UNIT_SYSTEMS[doc.units];
  const density = doc.material?.density ?? 1000;
  const L = u.length;
  const s = u.scale;
  const dec = Math.max(2, doc.decimals);
  const massKg = (mp.volume * 1e-9) * density;
  const mass = massKg / u.massScale;
  const fmt = (v: number, d = dec) => formatNumber(v, d);
  // Inertia per unit density (mm^5) to mass units * length^2.
  const inertiaScale = (density * 1e-9) / u.massScale / (s * s);
  const tensor = mp.inertia.map((x) => x * inertiaScale);
  const principal = mp.principal.moments.map((x) => x * inertiaScale);
  const rows: [string, string][] = [
    ['Material', doc.material ? `${doc.material.name} (${density} kg/m³)` : `Not specified (using ${density} kg/m³)`],
    ['Mass', `${fmt(mass)} ${u.mass}`],
    ['Volume', `${fmt(mp.volume / s ** 3)} ${L}³`],
    ['Surface area', `${fmt(mp.area / s ** 2)} ${L}²`],
    ['Center of mass', mp.center.map((c) => fmt(c / s)).join(', ') + ` ${L}`],
  ];
  const t = (i: number) => fmt(tensor[i], 3);
  const text = [
    `Mass properties of ${doc.name}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    `Moments of inertia about the center of mass (${u.mass}·${L}²):`,
    `Ixx ${t(0)}  Ixy ${t(1)}  Ixz ${t(2)}`,
    `Iyx ${t(3)}  Iyy ${t(4)}  Iyz ${t(5)}`,
    `Izx ${t(6)}  Izy ${t(7)}  Izz ${t(8)}`,
    `Principal moments: ${principal.map((x) => fmt(x, 3)).join(', ')}`,
  ].join('\n');
  const copy = h('button', { class: 'btn small', type: 'button' }, icon('copy', 14), 'Copy');
  const copyError = h('div', { class: 'field-label', role: 'alert', hidden: true, style: { color: 'var(--danger)' } },
    'Could not copy to the clipboard. Try again, or select and copy the report text manually.');
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    copyError.hidden = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast({ message: 'Copied to the clipboard', timeout: 1800 });
    } catch {
      copyError.hidden = false;
    } finally {
      copy.disabled = false;
    }
  });
  let stopWatching = () => {};
  await showDialog({
    title: 'Mass Properties',
    onReady: (close) => { stopWatching = app.store.on((reason) => { if (reason !== 'saved') close(null); }); },
    wide: true,
    body: [
      h('table', { class: 'table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'num' }, v))))),
      h('div', { class: 'field-label' }, `Moments of inertia about the center of mass, aligned with the part axes (${u.mass}·${L}²)`),
      h('table', { class: 'table' }, h('tbody', {},
        [0, 1, 2].map((r) => h('tr', {}, [0, 1, 2].map((c) => h('td', { class: 'num' }, `I${'xyz'[r]}${'xyz'[c]} = ${t(r * 3 + c)}`)))))),
      h('div', { class: 'field-label' }, `Principal moments: ${principal.map((x) => fmt(x, 3)).join(', ')}`),
      copy, copyError,
    ],
    buttons: [{ label: 'Close', value: 'ok', primary: true }],
  }).finally(() => stopWatching());
}

// ---------- shortcuts ----------

export async function shortcutsDialog(app: App) {
  const grid = h('div', { class: 'shortcut-grid' });
  const add = (label: string, keys: string) => grid.append(h('span', {}, label), h('span', {}, h('span', { class: 'kbd-key' }, keys)));
  grid.append(h('h3', {}, 'Mouse and touch'));
  add('Rotate view', 'Middle drag, right drag or left drag on the model');
  add('Pan', 'Ctrl + middle drag, Shift + right drag');
  add('Zoom at cursor', 'Wheel, Shift + middle drag, pinch');
  add('Pan and zoom on touch', 'Two fingers');
  add('Context menu', 'Right click or long press');
  grid.append(h('h3', {}, 'Commands'));
  // Commands with a second shortcut (Redo, Keyboard Shortcuts) are one row.
  const keys = new Map<string, string[]>();
  for (const c of app.commands.all().filter((x) => x.shortcut)) keys.set(c.label, [...(keys.get(c.label) ?? []), formatShortcut(c.shortcut)]);
  for (const [label, k] of [...keys].sort((a, b) => a[0].localeCompare(b[0]))) add(label, k.join(', '));
  grid.append(h('h3', {}, 'View'));
  add('Rotate 15 degrees', 'Arrow keys');
  add('Rotate 90 degrees', 'Shift + Arrow keys');
  add('Roll', 'Alt + Left/Right');
  add('Pan', `${isMac ? '⌘' : 'Ctrl'} + Arrow keys`);
  add('Cancel or clear selection', 'Esc');
  grid.append(h('h3', {}, 'Keyboard navigation'));
  add('Next or previous area (menu bar, CommandManager, design tree, graphics area, task pane, status bar)', 'F6, Shift + F6');
  add('Rename the feature in the design tree', 'F2');
  add('Context menu of the feature in the design tree', 'Shift + F10');
  await showDialog({ title: 'Keyboard Shortcuts', wide: true, body: grid, buttons: [{ label: 'Close', value: 'ok', primary: true }] });
}

export async function aboutDialog() {
  await showDialog({
    title: 'About Parametric',
    body: [
      h('p', {}, 'Parametric is an open-source, browser-based 3D CAD application for feature-based part modeling: constrained sketches, extrudes, revolves, fillets, shells, patterns and more, on the OpenCascade geometry kernel.'),
      h('p', {}, 'This is an early alpha. Please do not rely on it for production designs yet, and keep copies of important parts.'),
      h('p', {}, h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source code on GitHub'), ' · ',
        h('a', { href: './licenses/THIRD_PARTY_NOTICES.txt', target: '_blank', rel: 'noopener' }, 'Third-party notices')),
    ],
    buttons: [{ label: 'Close', value: 'ok', primary: true }],
  });
}

// ---------- measure ----------

export class MeasurePanel extends PropertyPanel {
  title = 'Measure';
  icon = 'measure';
  confirm = false;
  private out = h('div', { class: 'sec-body' });
  private box!: SelectionBox;

  constructor(private app: App) {
    super();
  }

  render(): HTMLElement[] {
    const app = this.app;
    this.box = new SelectionBox(this, 'Entities', { face: true, edge: true, vertex: true, plane: true }, (it) => this.convert(it), (items) => {
      if (items.length > 2) this.box.setItems(items.slice(-2));
      void this.measure();
    }, { placeholder: 'Select one or two faces, edges, vertices or planes', icon: 'measure' });
    const pre = app.selection.items.map((it) => this.convert(it)).filter((x): x is SelBoxItem => !!x).slice(0, 2);
    if (pre.length) { this.box.setItems(pre); void this.measure(); }
    return [section('Selections', [this.box.el]), h('section', { class: 'pm-section' }, this.out)];
  }

  private convert(it: SelItem): SelBoxItem | null {
    const app = this.app;
    switch (it.kind) {
      case 'face': return { item: it, data: it, label: `Face <${it.index + 1}> (${app.faces[it.index]?.type})` };
      case 'edge': return { item: it, data: it, label: `Edge <${it.index + 1}> (${app.edges[it.index]?.type})` };
      case 'vertex': {
        // Picking toggles by label: each vertex needs its own, or a second vertex would remove the first.
        const u = UNIT_SYSTEMS[app.store.doc.units];
        return { item: it, data: it, label: `Vertex (${it.p.map((c) => formatNumber(c / u.scale, app.store.doc.decimals)).join(', ')})` };
      }
      case 'plane': return { item: it, data: it, label: it.ref.kind === 'base' ? `${it.ref.plane[0].toUpperCase()}${it.ref.plane.slice(1)} Plane` : app.store.feature(it.ref.id)?.name ?? 'Plane' };
      default: return null;
    }
  }

  /** The part changed under the panel (e.g. Redo): keep what still exists and measure it again. */
  onBuild() {
    if (!this.box) return;
    const items = this.box.items
      .map((b) => remapItem(b.data as SelItem, this.app.faces, this.app.edges))
      .map((it) => (it ? this.convert(it) : null))
      .filter((x): x is SelBoxItem => !!x);
    this.box.setItems(items);
    void this.measure();
  }

  private seq = 0;

  private async measure() {
    const app = this.app;
    const seq = ++this.seq;
    const u = UNIT_SYSTEMS[app.store.doc.units];
    const dec = Math.max(2, app.store.doc.decimals);
    const L = (v: number) => `${formatNumber(v / u.scale, dec)} ${u.length}`;
    const A = (v: number) => `${formatNumber(v / u.scale ** 2, dec)} ${u.length}²`;
    const items = this.box.items.map((i) => i.data as SelItem);
    const lines: [string, string][] = [];
    const normalOf = (it: SelItem): Vec3 | null => {
      if (it.kind === 'face') return app.faces[it.index]?.normal ?? null;
      if (it.kind === 'plane') return app.frameOfPlane(it.ref)?.n ?? null;
      return null;
    };
    const dirOf = (it: SelItem): Vec3 | null => (it.kind === 'edge' ? app.edges[it.index]?.dir ?? null : null);
    for (const it of items) {
      if (it.kind === 'edge') {
        const e = app.edges[it.index];
        if (!e) continue;
        lines.push(['Edge length', L(e.length)]);
        if (e.radius) lines.push(['Radius', L(e.radius)], ['Diameter', L(e.radius * 2)]);
        if (e.center) lines.push(['Center', e.center.map((c) => formatNumber(c / u.scale, dec)).join(', ')]);
      } else if (it.kind === 'face') {
        const f = app.faces[it.index];
        if (!f) continue;
        lines.push(['Face area', A(f.area)]);
        if (f.radius) lines.push(['Radius', L(f.radius)], ['Diameter', L(f.radius * 2)]);
      } else if (it.kind === 'vertex') {
        lines.push(['X, Y, Z', it.p.map((c) => formatNumber(c / u.scale, dec)).join(', ')]);
      }
    }
    if (items.length === 2) {
      const [a, b] = items;
      const na = normalOf(a), nb = normalOf(b);
      const da = dirOf(a), db = dirOf(b);
      const va = na ?? da, vb = nb ?? db;
      if (va && vb) {
        const c = Math.min(1, Math.abs(dot(normalize(va), normalize(vb))));
        // Between an edge and a face or plane, the angle is to the surface, not to its normal.
        const mixed = !na !== !nb;
        const ang = ((mixed ? Math.asin(c) : Math.acos(c)) * 180) / Math.PI;
        lines.push(['Angle', `${formatNumber(ang, 2)}°`]);
      }
      const target = (it: SelItem): MeasureTarget | null => (it.kind === 'face' ? { kind: 'face', index: it.index } : it.kind === 'edge' ? { kind: 'edge', index: it.index } : it.kind === 'vertex' ? { kind: 'vertex', p: it.p } : null);
      const ta = target(a), tb = target(b);
      if (a.kind === 'plane' || b.kind === 'plane') {
        // No leader: the previous pair's would otherwise stay drawn.
        this.showLeader(null, null);
        const pl = a.kind === 'plane' ? a : b;
        const other = a.kind === 'plane' ? b : a;
        const fr = pl.kind === 'plane' ? app.frameOfPlane(pl.ref) : null;
        // One point stands for the whole entity only when it is parallel to the
        // plane; a tilted face, plane or edge is at no single distance from it.
        const cos = (v: Vec3 | null | undefined) => (fr && v ? Math.abs(dot(normalize(v), fr.n)) : NaN);
        const alongNormal = (v: Vec3 | null | undefined) => cos(v) > 1 - 1e-6;
        const e = other.kind === 'edge' ? app.edges[other.index] : null;
        const f = other.kind === 'face' ? app.faces[other.index] : null;
        const op = other.kind === 'plane' ? app.frameOfPlane(other.ref) : null;
        const p = other.kind === 'vertex' ? other.p
          : f ? (alongNormal(f.normal) ? f.center : null)
          : e ? (cos(e.dir) < 1e-6 || alongNormal(e.axis) ? e.mid : null)
          : op && alongNormal(op.n) ? op.o : null;
        if (fr && p) lines.push(['Normal distance', L(Math.abs(dot(sub(p, fr.o), fr.n)))]);
      } else if (ta && tb) {
        try {
          const r = await app.kernel.measure(ta, tb);
          // The selection changed while the kernel measured: a newer result is shown.
          if (seq !== this.seq) return;
          lines.push(['Distance', L(r.distance)]);
          const d = sub(r.p2, r.p1);
          lines.push(['dX, dY, dZ', d.map((x) => formatNumber(Math.abs(x) / u.scale, dec)).join(', ')]);
          this.showLeader(r.p1, r.p2);
        } catch (e) {
          if (seq !== this.seq) return;
          this.showLeader(null, null);
          lines.push(['Distance', (e as Error).message]);
        }
      }
    } else this.showLeader(null, null);
    this.out.textContent = '';
    if (!lines.length) this.out.append(h('div', { class: 'field-label' }, 'Select entities to measure.'));
    else this.out.append(h('table', { class: 'table' }, h('tbody', {}, lines.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'num' }, v))))));
  }

  private showLeader(a: Vec3 | null, b: Vec3 | null) {
    const r = this.app.renderer;
    if (!a || !b || dist(a, b) < 1e-9) { r.setLines('measure', null); r.setPoints('measure', null); return; }
    r.setLines('measure', { positions: new Float32Array([...a, ...b]), colors: new Uint8Array([240, 130, 30, 255]), width: 2, depth: 'always', order: 20 });
    r.setPoints('measure', { positions: new Float32Array([...a, ...b]), colors: new Uint8Array([240, 130, 30, 255, 240, 130, 30, 255]), sizeStyle: new Float32Array([7, 1, 7, 1]), depth: 'always', order: 20 });
  }

  ok() { return true; }

  dispose() {
    // A measurement still running must not draw its leader after the panel closed.
    this.seq++;
    this.showLeader(null, null);
  }
}

/** Tools store physical numeric lengths, so context changes only replace their fields. */
abstract class NumericToolPanel extends PropertyPanel {
  private units: UnitSystem;
  private variables: Variable[];

  constructor(protected app: App) {
    super();
    this.units = app.store.doc.units;
    this.variables = structuredClone(app.store.doc.variables);
  }

  syncExpressions(): string[] | null {
    const units = this.app.store.doc.units, variables = this.variables;
    this.variables = structuredClone(this.app.store.doc.variables);
    if (units === this.units && !variableReferenceChanges(variables, this.variables).size) return null;
    const previous = this.units;
    this.units = units;
    // Settle pending input with its old units and names before the app remounts the panel.
    // Pass the evaluated number so callbacks cannot reinterpret an expression in the new units.
    const values = evaluateVariables(variables).values;
    settleNumberFields(this.el, { units: previous, decimals: this.app.store.doc.decimals, variables: () => values }, (_value, num) => num);
    return [];
  }
}

// ---------- section view ----------

export class SectionPanel extends NumericToolPanel {
  title = 'Section View';
  icon = 'sectionView';
  private normal: Vec3 = [0, 0, 1];
  private offset = 0;
  private flip = false;
  private base: 'front' | 'top' | 'right' | 'custom' = 'front';
  /** The plane the panel started from (the active section or a selected plane or face). */
  private custom: { normal: Vec3; offset: number; label: string } | null = null;
  private originalSection: App['renderer']['section'];

  constructor(app: App) {
    super(app);
    this.originalSection = app.renderer.section;
    if (app.renderer.section) this.custom = { ...app.renderer.section, label: 'Current' };
    else {
      const ref = app.selectedPlaneRef();
      const fr = ref ? app.frameOfPlane(ref) : null;
      if (fr) this.custom = { normal: fr.n, offset: dot(fr.o, fr.n), label: 'Selected' };
      else if (app.bbox) this.offset = (app.bbox.min[2] + app.bbox.max[2]) / 2;
    }
    if (this.custom) {
      this.normal = this.custom.normal;
      this.offset = this.custom.offset;
      // A plane parallel to a base plane is that base plane at an offset.
      const k = (['front', 'top', 'right'] as const).find((b) => BASE_FRAMES[b].n.every((v, i) => Math.abs(v - this.custom!.normal[i]) < 1e-9));
      if (k) { this.base = k; this.custom = null; } else this.base = 'custom';
    }
  }

  private apply() {
    const n: Vec3 = this.flip ? [-this.normal[0], -this.normal[1], -this.normal[2]] : this.normal;
    this.app.renderer.section = { normal: n, offset: this.flip ? -this.offset : this.offset };
    this.app.renderer.requestRender();
  }

  render(): HTMLElement[] {
    // Mount after the previous panel cancels, so its cleanup cannot clear this plane.
    this.apply();
    const app = this.app;
    const offset = numberField({ label: 'Offset', icon: 'ruler', value: this.offset, kind: 'length', ctx: app.unitContext(), onChange: (v) => { this.offset = app.store.evalParam(v, 'length'); this.apply(); }, onLive: (v) => { this.offset = v; this.apply(); } });
    const custom = this.custom;
    const plane = segmented('Section plane', this.base, [
      { value: 'front' as const, label: 'Front' }, { value: 'top' as const, label: 'Top' }, { value: 'right' as const, label: 'Right' },
      ...(custom ? [{ value: 'custom' as const, label: custom.label }] : []),
    ], (v) => {
      this.base = v;
      if (v === 'custom') {
        if (custom) { this.normal = custom.normal; this.offset = custom.offset; }
        this.apply();
        app.refreshPanel();
        return;
      }
      this.normal = BASE_FRAMES[v].n;
      const b = app.bbox;
      const axis = v === 'front' ? 2 : v === 'top' ? 1 : 0;
      this.offset = b ? (b.min[axis] + b.max[axis]) / 2 : 0;
      this.apply();
      app.refreshPanel();
    });
    return [section('Section Plane', [
      plane,
      offset,
      checkbox('Flip side', this.flip, (v) => { this.flip = v; this.apply(); }),
      h('p', { class: 'field-label' }, 'Select a plane or planar face before starting to cut along it. Press OK to keep the section active; run Section View again to turn it off.'),
    ])];
  }

  ok() { return true; }

  cancel() {
    // Detaching a focused field can fire change before it leaves the document.
    retireNumberFields(this.el);
    this.app.renderer.section = this.originalSection;
    this.app.renderer.requestRender();
  }
}

// ---------- sketch tools with panels ----------

export class OffsetPanel extends NumericToolPanel {
  title = 'Offset Entities';
  icon = 'offset';
  private distance: number;
  private reverse = false;

  constructor(app: App) {
    super(app);
    this.distance = app.typicalSize() / 5;
    this.helpText = 'Select a chain of sketch curves before starting, then set the distance.';
  }

  render(): HTMLElement[] {
    const ids = this.app.sketchEditor?.selectedIds() ?? [];
    return [section('Parameters', [
      numberField({ label: 'Offset distance', icon: 'ruler', value: this.distance, kind: 'length', ctx: this.app.unitContext(), min: 1e-6, onChange: (v) => { this.distance = this.app.store.evalParam(v, 'length'); } }),
      checkbox('Reverse (inward)', this.reverse, (v) => { this.reverse = v; }),
      h('div', { class: 'field-label' }, `${ids.length} entities selected`),
    ])];
  }

  ok() {
    const ed = this.app.sketchEditor;
    if (!ed) return true;
    const ids = ed.selectedIds();
    if (!ids.length) { this.setMessage('error', 'Select sketch curves to offset first.'); return false; }
    let created: string[] = [];
    ed.edit('Offset entities', (sk, newId) => { created = offsetCurves(sk, ids, this.reverse ? -this.distance : this.distance, newId); });
    if (!created.length) toast({ kind: 'warning', message: 'Nothing could be offset with that distance.' });
    return true;
  }
}

export function mirrorSketchEntities(app: App) {
  const ed = app.sketchEditor;
  if (!ed) return;
  const ids = ed.selectedIds();
  const sk = ed.sketch;
  const lines = ids.filter((id) => sk.entities.find((e) => e.id === id)?.t === 'line');
  // The mirror line is the selected centerline, or the last selected line.
  const axis = lines.find((id) => sk.entities.find((e) => e.id === id)?.construction) ?? lines[lines.length - 1];
  if (!axis || ids.length < 2) { toast({ kind: 'warning', message: 'Select the entities to mirror and a line (ideally a centerline) to mirror about.' }); return; }
  if (!mirrorAxisDirection(new SketchIndex(sk.entities), axis)) { toast({ kind: 'warning', message: 'Choose a mirror axis with distinct endpoints.' }); return; }
  ed.edit('Mirror entities', (s2, newId) => { mirrorEntities(s2, ids.filter((x) => x !== axis), axis, newId); });
}

/** Projects selected model edges onto the sketch plane as fixed geometry. */
export function convertEntities(app: App) {
  const ed = app.sketchEditor;
  if (!ed) return;
  const edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter(Boolean);
  const faces = app.selection.ofKind('face').map((s) => app.faces[s.index]).filter(Boolean);
  // A selected face converts all of its edges.
  for (const f of faces) {
    const fi = app.faces.indexOf(f);
    for (const e of app.edges) if (e.faces.includes(fi) && !edges.includes(e)) edges.push(e);
  }
  if (!edges.length) { toast({ kind: 'warning', message: 'Select model edges or faces to convert into the sketch.' }); return; }
  let skipped = 0;
  ed.edit('Convert entities', (sk, newId) => { skipped = convertEdges(sk, ed.frame, edges, newId).skipped; });
  app.selection.clear();
  if (skipped) toast({ kind: 'warning', message: `${skipped} edge(s) could not be converted (only lines, and circles parallel to the sketch plane are supported).` });
}

export function dimensionValueText(app: App, d: SkDimension): string {
  const u = UNIT_SYSTEMS[app.store.doc.units];
  return d.type === 'angle' ? `${d.value}°` : typeof d.value === 'string' ? d.value : `${formatNumber(d.value / u.scale, app.store.doc.decimals)} ${u.length}`;
}
