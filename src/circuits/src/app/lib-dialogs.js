// Component creation and the project library manager. A component pairs a
// symbol (from a generator or a pin table) with a footprint (from a wizard
// or copied from another component); previews update as you type.

import { h, clear, nextId } from '../ui/dom.js';
import { openDialog, buildForm, confirmDialog } from '../ui/dialog.js';
import * as S from '../model/library/symbols.js';
import { FOOTPRINT_WIZARDS, SYMBOL_WIZARD, parsePinTable } from '../model/library/wizards.js';
import { overlappingPads } from '../model/library/footprints.js';
import { BUILTIN_COMPONENTS, CATEGORIES } from '../model/library/builtin.js';
import { drawSymbolPreview, drawFootprintPreview } from '../ui/preview.js';
import { resolvedTheme } from './theme.js';
import { uid } from '../core/emitter.js';
import { download, pickDeviceFile, safeName } from './storage.js';
import { LIBRARY_FORMAT } from '../model/schema.js';

const SYMBOLS = [
  ['ic', 'Integrated circuit (from a pin list)', null],
  ['resistor', 'Resistor', () => S.resistor()],
  ['capacitor', 'Capacitor', () => S.capacitor()],
  ['polarizedCapacitor', 'Polarized capacitor', () => S.polarizedCapacitor()],
  ['inductor', 'Inductor', () => S.inductor()],
  ['ferriteBead', 'Ferrite bead', () => S.ferriteBead()],
  ['fuse', 'Fuse', () => S.fuse()],
  ['diode', 'Diode', () => S.diode()],
  ['zener', 'Zener diode', () => S.zener()],
  ['schottky', 'Schottky diode', () => S.schottky()],
  ['led', 'LED', () => S.led()],
  ['npn', 'NPN transistor (1 B, 2 E, 3 C)', () => S.bjt('npn')],
  ['pnp', 'PNP transistor (1 B, 2 E, 3 C)', () => S.bjt('pnp')],
  ['nmos', 'N-channel MOSFET (1 G, 2 S, 3 D)', () => S.mosfet('n')],
  ['pmos', 'P-channel MOSFET (1 G, 2 S, 3 D)', () => S.mosfet('p')],
  ['crystal', 'Crystal', () => S.crystal()],
  ['switch', 'Switch', () => S.switchSPST()],
  ['button', 'Push button', () => S.pushButton()],
  ['battery', 'Battery', () => S.battery()],
  ['connector', 'Connector, one row', null],
  ['connector2', 'Connector, two rows', null],
  ['testPoint', 'Test point', () => S.testPoint()],
  ['regulator', 'Voltage regulator (1 GND, 2 OUT, 3 IN)', () => S.regulator()],
];

const DEFAULT_PINS = '1, VCC, power, left\n2, IN, input, left\n3, OUT, output, right\n4, GND, power, right';

/** Builds wizard form fields from wizard metadata. */
function wizardFields(w) {
  return w.fields.map((f) => {
    if (f.type === 'select') return { key: f.key, label: f.label, type: 'select', value: f.default, options: f.options.map((o) => (typeof o === 'object' ? [o.value, o.label] : [o, o])) };
    if (f.type === 'bool') return { key: f.key, label: f.label, type: 'bool', value: !!f.default };
    if (f.type === 'length') return { key: f.key, label: `${f.label} (mm)`, type: 'number', value: (f.default ?? 0) / 1e6, step: 0.01, parse: (v) => Math.round(Number(v) * 1e6), min: f.min != null ? f.min / 1e6 : undefined };
    if (f.type === 'int') return { key: f.key, label: f.label, type: 'number', value: f.default ?? 0, min: f.min, max: f.max, step: f.step || 1, parse: (v) => Math.round(Number(v)) };
    return { key: f.key, label: f.label, type: 'text', value: f.default ?? '' };
  });
}

export async function newComponentDialog(app, { start = 'symbol', edit = null } = {}) {
  const project = app.project;
  const base = edit ? structuredClone(edit) : null;
  const general = buildForm([
    { key: 'name', label: 'Name', type: 'text', value: base?.name || 'New component', required: true },
    { key: 'prefix', label: 'Designator prefix', type: 'text', value: base?.prefix || 'U', required: true },
    { key: 'value', label: 'Default value', type: 'text', value: base?.value || '' },
    { key: 'description', label: 'Description', type: 'text', value: base?.description || '' },
    { key: 'category', label: 'Category', type: 'select', value: base?.category || 'Integrated Circuits', options: CATEGORIES.map((c) => [c, c]) },
  ]);

  // Symbol source.
  const symSel = h('select', { id: nextId('sym') }, h('option', { value: 'keep', hidden: !base }, 'Keep the current symbol'), SYMBOLS.map(([k, l]) => h('option', { value: k }, l)));
  symSel.value = base ? 'keep' : 'ic';
  const pinText = h('textarea', { rows: 8, spellcheck: 'false', 'aria-label': 'Pin list: number, name, type, side' }, DEFAULT_PINS);
  const symFieldSpecs = ['minWidth', 'sort'].map((k) => SYMBOL_WIZARD.fields.find((f) => f.key === k)).filter(Boolean).map((f) => (f.type === 'select'
    ? { key: f.key, label: f.label, type: 'select', value: f.default, options: f.options.map((o) => [o.value, o.label]) }
    : { key: f.key, label: f.label, type: 'number', value: f.default, min: f.min, max: f.max, step: f.step }));
  const symOpts = buildForm(symFieldSpecs);
  const conCount = h('input', { type: 'number', min: 1, max: 80, value: 4, 'aria-label': 'Pin count' });
  const pinErr = h('div.small.sev-error', { role: 'alert' });
  const symExtra = h('div');

  // Footprint source.
  const fpSel = h('select', { id: nextId('fp') },
    h('option', { value: 'keep', hidden: !base?.footprint }, 'Keep the current footprint'),
    h('option', { value: 'none' }, 'No footprint (schematic only)'),
    h('optgroup', { label: 'Wizards' }, FOOTPRINT_WIZARDS.map((w) => h('option', { value: `wiz:${w.id}` }, w.name))),
    h('option', { value: 'copy' }, 'Copy from another component'));
  fpSel.value = base?.footprint ? 'keep' : start === 'footprint' ? 'wiz:soic' : 'wiz:soic';
  const fpExtra = h('div');
  let fpForm = null;
  const copySel = h('select', { 'aria-label': 'Component to copy the footprint from' }, BUILTIN_COMPONENTS.filter((d) => d.footprint).map((d) => h('option', { value: d.id }, `${d.footprint.name} (${d.name})`)));

  const symCanvas = h('canvas', { style: { width: '100%', height: '180px' }, 'aria-hidden': 'true' });
  const fpCanvas = h('canvas', { style: { width: '100%', height: '180px' }, 'aria-hidden': 'true' });
  const status = h('div.small', { 'aria-live': 'polite' });
  const err = h('div.small.sev-error', { role: 'alert' });

  const renderSymExtra = () => {
    clear(symExtra);
    if (symSel.value === 'ic') symExtra.append(h('label.small.muted', 'One pin per line: number, name, type (input, output, bidir, power, passive, oc, nc), side (left, right, top, bottom). You can paste from a spreadsheet.'), pinText, symOpts.el, pinErr);
    else if (symSel.value === 'connector' || symSel.value === 'connector2') symExtra.append(h('label.check-row', 'Pins per row ', conCount));
  };
  const renderFpExtra = () => {
    clear(fpExtra);
    fpForm = null;
    if (fpSel.value.startsWith('wiz:')) {
      const w = FOOTPRINT_WIZARDS.find((x) => x.id === fpSel.value.slice(4));
      fpForm = buildForm(wizardFields(w));
      fpForm.el.addEventListener('input', update);
      fpForm.el.addEventListener('change', update);
      fpExtra.append(fpForm.el);
    } else if (fpSel.value === 'copy') fpExtra.append(copySel);
  };

  const buildSymbol = () => {
    pinErr.textContent = '';
    const k = symSel.value;
    if (k === 'keep') return base.symbol;
    if (k === 'ic') {
      const { pins, errors } = parsePinTable(pinText.value);
      if (errors?.length) pinErr.textContent = errors.slice(0, 3).join(' ');
      if (!pins.length) return null;
      const o = symOpts.values();
      return SYMBOL_WIZARD.generate({ pins, minWidth: Number(o.minWidth) || 600, sort: o.sort || 'table' });
    }
    if (k === 'connector') return S.connector1(Math.max(1, Math.min(80, Number(conCount.value) || 1)));
    if (k === 'connector2') return S.connector2(Math.max(1, Math.min(40, Number(conCount.value) || 1)));
    return SYMBOLS.find(([id]) => id === k)?.[2]?.() || null;
  };
  // Why the chosen wizard could not make a usable footprint, or ''.
  let fpError = '';
  const buildFootprint = () => {
    fpError = '';
    const k = fpSel.value;
    if (k === 'keep') return base.footprint;
    if (k === 'none') return null;
    if (k === 'copy') return structuredClone(BUILTIN_COMPONENTS.find((d) => d.id === copySel.value)?.footprint || null);
    const w = FOOTPRINT_WIZARDS.find((x) => x.id === k.slice(4));
    if (!fpForm) return null;
    const invalid = fpForm.validate({ focus: false });
    if (invalid) { fpError = `Footprint: ${invalid}`; return null; }
    let fp;
    try { fp = w.generate(fpForm.values()); } catch (e) { fpError = `Footprint: ${e.message}`; return null; }
    const clash = overlappingPads(fp.pads);
    if (clash) {
      fpError = `Pads ${clash[0]} and ${clash[1]} overlap. Increase the pitch or spacing, or make the pads smaller.`;
    }
    return fp;
  };

  let current = { symbol: null, footprint: null };
  function update() {
    const symbol = buildSymbol();
    const footprint = buildFootprint();
    current = { symbol, footprint };
    const def = { symbol: symbol || { pins: [], graphics: [] }, footprint };
    const theme = resolvedTheme();
    drawSymbolPreview(symCanvas, def, theme);
    drawFootprintPreview(fpCanvas, def, theme);
    // Pins and pads should match one to one.
    clear(status);
    err.textContent = '';
    if (fpError) status.append(h('div.sev-error', fpError));
    if (symbol && footprint) {
      const pads = new Set(footprint.pads.map((p) => p.num));
      const pins = new Set(symbol.pins.map((p) => p.num));
      const noPad = [...pins].filter((n) => !pads.has(n));
      const noPin = [...pads].filter((n) => n && !pins.has(n));
      if (noPad.length) status.append(h('div.sev-warning', `Pins without a pad: ${noPad.slice(0, 12).join(', ')}${noPad.length > 12 ? '...' : ''}`));
      if (noPin.length) status.append(h('div.muted', `Pads without a pin (left unconnected): ${noPin.slice(0, 12).join(', ')}${noPin.length > 12 ? '...' : ''}`));
      if (!noPad.length && !noPin.length) status.append(h('div.sev-info', `${pins.size} pins match ${pads.size} pads.`));
    }
  }
  symSel.addEventListener('change', () => { renderSymExtra(); update(); });
  fpSel.addEventListener('change', () => { renderFpExtra(); update(); });
  for (const el of [pinText, conCount, copySel]) { el.addEventListener('input', update); el.addEventListener('change', update); }
  symOpts.el.addEventListener('change', update);
  renderSymExtra();
  renderFpExtra();

  const col = (title, ...kids) => h('section', { style: { display: 'grid', gap: '8px', alignContent: 'start', minWidth: '0' } }, h('h3', { style: { margin: 0, fontSize: 'var(--fs-md)' } }, title), ...kids);
  const body = h('div', { style: { display: 'grid', gap: '16px' } },
    general.el,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' } },
      col('Symbol', h('label.small.muted', { for: symSel.id }, 'Symbol'), symSel, symExtra, h('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' } }, symCanvas)),
      col('Footprint', h('label.small.muted', { for: fpSel.id }, 'Footprint'), fpSel, fpExtra, h('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' } }, fpCanvas))),
    status);

  let created = null;
  body.append(err);
  const dlg = openDialog({
    title: edit ? `Edit ${edit.name}` : 'New component', size: 'xwide',
    body,
    actions: [{ label: 'Cancel' }, {
      label: edit ? 'Save component' : 'Create component', primary: true,
      run: () => {
        const msg = general.validate();
        if (msg) { err.textContent = msg; return false; }
        update();
        if (!current.symbol || !current.symbol.pins) { err.textContent = 'The symbol is empty. Add at least one pin.'; return false; }
        if (fpError) { fpForm?.validate(); err.textContent = fpError; return false; }
        const g = general.values();
        const id = edit?.id || `user-${safeName(g.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${uid().slice(-5)}`;
        created = {
          ...(base || {}), id, name: g.name.trim(), prefix: g.prefix.trim().replace(/[^A-Za-z_]/g, '') || 'U', value: g.value, description: g.description, category: g.category,
          params: base?.params || {}, keywords: base?.keywords || [], symbol: current.symbol, footprint: current.footprint,
        };
        project.putComponent(created);
        app.userLibrary?.put(created);
        return true;
      },
    }],
  });
  requestAnimationFrame(update);
  await dlg.result;
  if (created) {
    app.toast(`${created.name} ${edit ? 'updated' : 'added to the project library'}.`, {
      kind: 'success',
      actions: [
        ...(!edit && (app.activeEditor?.kind === 'sch' || app.activeEditor?.kind === 'pcb') ? [{ label: 'Place it', primary: true, run: () => (app.activeEditor.kind === 'sch' ? app.activeEditor.placePart(created) : app.activeEditor.placeComponent?.(created)) }] : []),
        { label: 'Open in editor', run: () => app.openComponentEditor?.(created.id) },
      ],
    });
  }
  return created;
}

export async function libraryDialog(app) {
  const project = app.project;
  const host = h('div');
  const render = () => {
    clear(host);
    const used = new Map();
    for (const d of project.docs) for (const o of d.items()) if (o.comp) used.set(o.comp, (used.get(o.comp) || 0) + 1);
    const defs = Object.values(project.library).sort((a, b) => a.name.localeCompare(b.name));
    if (!defs.length) { host.append(h('p.muted', 'The project library is empty. Components are added when you place them.')); return; }
    host.append(h('div.table-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Component'), h('th', 'Footprint'), h('th', 'Pins'), h('th', 'Used'), h('th', h('span.sr-only', 'Actions')))),
      h('tbody', defs.map((d) => h('tr',
        h('td', d.name), h('td', d.footprint?.name || 'None'), h('td', String(d.symbol?.pins?.length || 0)), h('td', String(used.get(d.id) || 0)),
        h('td', { style: { textAlign: 'right' } },
          h('button.btn.sm', { type: 'button', onClick: () => { dlg?.close(); app.openComponentEditor(d.id); } }, 'Edit'), ' ',
          h('button.btn.sm', { type: 'button', disabled: !!used.get(d.id), title: used.get(d.id) ? 'In use' : '', onClick: () => { delete project.library[d.id]; project.touchMeta(); render(); } }, 'Remove'))))))));
  };
  let dlg = null;
  render();
  dlg = openDialog({
    title: 'Project component library', size: 'wide',
    body: [h('p.muted', 'Every component placed in this project is stored with it, so the project opens the same way anywhere. Editing a component here updates every place it is used.'), host],
    actions: [
      { label: 'Import library file...', left: true, run: async () => {
        const f = await pickDeviceFile('.circuitslib,.json');
        if (!f) return false;
        try {
          const data = JSON.parse(f.text);
          if (data.format !== LIBRARY_FORMAT || !Array.isArray(data.components)) throw new Error('This is not a Circuits library file.');
          for (const d of data.components) if (d?.id && d.symbol) project.putComponent(d);
          app.toast(`Imported ${data.components.length} components.`, { kind: 'success' });
          render();
        } catch (err) { app.toast(err.message, { kind: 'error' }); }
        return false;
      } },
      { label: 'Export library file', left: true, run: () => {
        download(JSON.stringify({ format: LIBRARY_FORMAT, version: 1, name: project.name, components: Object.values(project.library) }, null, 1), `${safeName(project.name)}.circuitslib`, 'application/json');
        return false;
      } },
      { label: 'Remove unused', left: true, run: async () => {
        const unused = project.unusedComponents();
        if (!unused.length) { app.toast('Every component in the library is in use.'); return false; }
        if (await confirmDialog({ title: 'Remove unused components', message: `Remove ${unused.length} unused component${unused.length === 1 ? '' : 's'} from the project library?`, confirm: 'Remove' })) {
          for (const id of unused) delete project.library[id];
          project.touchMeta();
          render();
        }
        return false;
      } },
      { label: 'Close', primary: true },
    ],
  });
  await dlg.result;
}
