// Application dialogs.

import { h, nextId, clear, shortcutLabel } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, buildForm, confirmDialog } from '../ui/dialog.js';
import { formatLength, parseLength, mm } from '../core/units.js';
import { isCopper } from '../model/layers.js';
import { arcToPoints, bboxOfFlat, polyArea } from '../core/geom.js';
import { planSync, applySync } from '../model/sync.js';
import { planAnnotation } from '../model/annotate.js';
import { listProjects, locationLabel, deleteProject } from './storage.js';
import { cloudAvailable } from './puter.js';
import { sharedWithMe } from './share.js';

const lengthField = (key, label, value, units, extra = {}) => ({
  key, label, type: 'length', value: formatLength(value, units, { suffix: false }), parse: (v) => parseLength(v, units), hint: units, ...extra,
});

// ---- Design rules ----

export async function rulesDialog(app, ed) {
  const u = app.settings.get('units');
  const r = ed.doc.rules;
  const form = buildForm([
    lengthField('clearance', 'Copper clearance', r.clearance, u),
    lengthField('trackWidth', 'Track width (preferred)', r.trackWidth, u),
    lengthField('minTrackWidth', 'Track width (minimum)', r.minTrackWidth, u),
    lengthField('viaDiameter', 'Via diameter', r.viaDiameter, u),
    lengthField('viaDrill', 'Via hole', r.viaDrill, u),
    lengthField('minDrill', 'Minimum hole', r.minDrill, u),
    lengthField('minAnnularRing', 'Minimum annular ring', r.minAnnularRing, u),
    lengthField('edgeClearance', 'Copper to board edge', r.edgeClearance, u),
    lengthField('pourClearance', 'Pour clearance (new pours)', r.pourClearance, u),
    lengthField('spoke', 'Thermal relief spoke width', r.thermal.spoke, u),
    lengthField('gap', 'Thermal relief gap', r.thermal.gap, u),
    lengthField('maskExpansion', 'Solder mask expansion', r.maskExpansion, u),
    lengthField('pasteExpansion', 'Paste expansion', r.pasteExpansion, u),
    lengthField('silkWidth', 'Silkscreen line width', r.silkWidth, u),
  ]);
  // Net classes as an editable table.
  const classes = structuredClone(r.netClasses || {});
  const nets = Object.keys(ed.doc.nets).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const tableHost = h('div');
  const renderClasses = () => {
    clear(tableHost);
    const rows = Object.entries(classes).map(([name, c]) => {
      const w = h('input', { type: 'text', value: formatLength(c.width, u, { suffix: false }), 'aria-label': `${name} track width`, style: { width: '80px' } });
      const cl = h('input', { type: 'text', value: formatLength(c.clearance, u, { suffix: false }), 'aria-label': `${name} clearance`, style: { width: '80px' } });
      const ns = h('input', { type: 'text', value: (c.nets || []).join(', '), 'aria-label': `${name} nets`, placeholder: 'GND, VCC', list: 'net-names', style: { width: '100%' } });
      w.addEventListener('change', () => { const v = parseLength(w.value, u); if (v > 0) c.width = v; });
      cl.addEventListener('change', () => { const v = parseLength(cl.value, u); if (v >= 0) c.clearance = v; });
      ns.addEventListener('change', () => { c.nets = ns.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean); });
      return h('tr', h('td', name), h('td', w), h('td', cl), h('td', { style: { width: '100%' } }, ns),
        h('td', h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete class ${name}`, onClick: () => { delete classes[name]; renderClasses(); } }, icon('trash', 13))));
    });
    tableHost.append(
      h('datalist#net-names', nets.map((n) => h('option', { value: n }))),
      h('div.table-wrap', h('table.grid', h('thead', h('tr', h('th', 'Class'), h('th', `Width (${u})`), h('th', `Clearance (${u})`), h('th', 'Nets'), h('th', h('span.sr-only', 'Actions')))), h('tbody', rows))),
      h('button.btn.sm', { type: 'button', style: { marginTop: '8px' }, onClick: () => {
        let n = 1;
        while (classes[`Class${n}`]) n++;
        classes[`Class${n}`] = { width: r.trackWidth, clearance: r.clearance, nets: [] };
        renderClasses();
      } }, icon('plus', 13), 'Add net class'),
    );
  };
  renderClasses();
  const tabs = h('div.tabs-row', { role: 'tablist' });
  const pages = { rules: form.el, classes: tableHost };
  const pageHost = h('div');
  const show = (k) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.k === k));
    pageHost.replaceChildren(pages[k]);
  };
  for (const [k, l] of [['rules', 'Clearances and sizes'], ['classes', 'Net classes']]) tabs.append(h('button', { type: 'button', role: 'tab', dataset: { k }, onClick: () => show(k) }, l));
  show('rules');
  const err = h('div.small.sev-error', { role: 'alert' });
  const oldWidth = r.trackWidth;
  let newWidth = null;
  await openDialog({
    title: 'Design rules', size: 'wide',
    body: [tabs, pageHost, err],
    actions: [{ label: 'Cancel' }, {
      label: 'Apply', primary: true,
      run: () => {
        const msg = form.validate();
        if (msg) { err.textContent = msg; show('rules'); return false; }
        const v = form.values();
        const next = { ...v, thermal: { ...r.thermal, spoke: v.spoke, gap: v.gap }, netClasses: classes };
        delete next.spoke; delete next.gap;
        ed.doc.store.transact('Edit design rules', (s) => s.update('rules', next));
        newWidth = next.trackWidth;
        return true;
      },
    }],
  }).result;
  // Offer to carry a new preferred width over to the tracks routed at the old one.
  if (!newWidth || newWidth === oldWidth) return;
  const ids = [...ed.doc.items()].filter((o) => (o.t === 'track' || o.t === 'arc') && isCopper(o.layer) && o.w === oldWidth).map((o) => o.id);
  if (!ids.length) return;
  const from = formatLength(oldWidth, u), to = formatLength(newWidth, u);
  if (await confirmDialog({ title: 'Update existing tracks', message: `Change ${ids.length} existing track${ids.length === 1 ? '' : 's'} from ${from} to ${to}? New tracks use ${to} either way.`, confirm: 'Update tracks' })) {
    ed.doc.store.transact('Change track width', (s) => { for (const id of ids) s.update(id, { w: newWidth }); });
  }
}

export async function layerStackDialog(app, ed) {
  const b = ed.doc.board;
  const u = app.settings.get('units');
  const form = buildForm([
    { key: 'copper', label: 'Copper layers', type: 'select', value: String(b.copper), options: [['2', '2 layers'], ['4', '4 layers (2 inner)'], ['6', '6 layers (4 inner)']] },
    lengthField('thickness', 'Board thickness', b.thickness, u),
  ]);
  await openDialog({
    title: 'Layer stack',
    body: [h('p.muted', 'Inner layers are added between the top and bottom copper. Removing inner layers deletes the tracks, fills and pours on them.'), form.el],
    actions: [{ label: 'Cancel' }, {
      label: 'Apply', primary: true,
      run: async () => {
        if (form.validate()) return false;
        const v = form.values();
        await app.setCopperLayers(Number(v.copper));
        ed.doc.store.transact('Board thickness', (s) => s.update('board', { thickness: v.thickness }));
        return true;
      },
    }],
  }).result;
}

export async function boardSizeDialog(app, ed) {
  const u = app.settings.get('units');
  const bb = bboxOfFlat(ed.doc.board.outline);
  const form = buildForm([
    lengthField('w', 'Width', bb.maxX - bb.minX, u),
    lengthField('h', 'Height', bb.maxY - bb.minY, u),
    lengthField('r', 'Corner radius', 0, u),
    { key: 'holes', label: 'Add mounting holes in the corners', type: 'bool', value: false },
  ]);
  const err = h('div.small.sev-error', { role: 'alert' });
  await openDialog({
    title: 'Board size',
    body: [h('p.muted', 'Makes the board a rectangle starting at its current lower left corner.'), form.el, err],
    actions: [{ label: 'Cancel' }, {
      label: 'Apply', primary: true,
      run: () => {
        const msg = form.validate();
        if (msg) { err.textContent = msg; return false; }
        const { w, h: ht, r, holes } = form.values();
        if (w < mm(1) || ht < mm(1)) { err.textContent = 'The board must be at least 1 mm on each side.'; return false; }
        const rad = Math.max(0, Math.min(r, w / 2, ht / 2));
        const x0 = bb.minX, y0 = bb.minY;
        let outline;
        if (rad > 0) {
          outline = [];
          for (const [cx, cy, a0] of [[x0 + w - rad, y0 + rad, 270], [x0 + w - rad, y0 + ht - rad, 0], [x0 + rad, y0 + ht - rad, 90], [x0 + rad, y0 + rad, 180]]) {
            const pts = arcToPoints(cx, cy, rad, a0, 90, 2000);
            for (let i = 0; i < pts.length; i += 2) outline.push(Math.round(pts[i]), Math.round(pts[i + 1]));
          }
        } else outline = [x0, y0, x0 + w, y0, x0 + w, y0 + ht, x0, y0 + ht];
        ed.doc.store.transact('Set board size', (s) => {
          s.update('board', { outline });
          if (holes) {
            const off = mm(3.5);
            for (const [x, y] of [[x0 + off, y0 + off], [x0 + w - off, y0 + off], [x0 + w - off, y0 + ht - off], [x0 + off, y0 + ht - off]]) {
              s.add({ t: 'pad', x, y, shape: 'round', w: mm(6), h: mm(6), side: 'thru', drill: mm(3.2), plated: false, num: '' });
            }
          }
        });
        ed.fitBoard();
        return true;
      },
    }],
  }).result;
}

// ---- Schematic to board ----

export async function syncDialog(app, board) {
  const project = app.project;
  const changes = planSync(project, board);
  if (!changes.length) {
    app.toast(`${board.name} is up to date with the schematic.`, { kind: 'success' });
    return false;
  }
  const checks = new Map();
  const kindLabel = { add: 'Add component', remove: 'Remove component', update: 'Update component', nets: 'Assign pad nets', netlist: 'Net list' };
  const rows = changes.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `${c.label}: ${c.detail}` });
    checks.set(c, cb);
    return h('tr', h('td', cb), h('td', kindLabel[c.kind] || c.kind), h('td', c.label), h('td.muted', { style: { whiteSpace: 'normal' } }, c.detail));
  });
  const all = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Select all changes' });
  all.addEventListener('change', () => { for (const cb of checks.values()) cb.checked = all.checked; });
  let applied = false;
  await openDialog({
    title: `Update ${board.name} from the schematic`, size: 'wide',
    body: [
      h('p', `${changes.length} change${changes.length === 1 ? '' : 's'} will bring the board in line with the schematic. New components are placed beside the board. The update is one step you can undo.`),
      h('div.table-wrap', h('table.grid', h('thead', h('tr', h('th', all), h('th', 'Action'), h('th', 'Object'), h('th', 'Details'))), h('tbody', rows))),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Apply changes', primary: true,
      run: () => {
        const chosen = changes.filter((c) => checks.get(c).checked);
        if (chosen.length) { applySync(board, chosen); applied = true; }
        return true;
      },
    }],
  }).result;
  return applied;
}

export async function annotateDialog(app) {
  const project = app.project;
  const order = h('select', { id: nextId('ann') }, h('option', { value: 'across' }, 'Across, then down (rows)'), h('option', { value: 'down' }, 'Down, then across (columns)'));
  const reset = h('input', { type: 'checkbox' });
  const preview = h('div');
  const plan = () => planAnnotation(project.sheetObjects(), project.library, { order: order.value, reset: reset.checked });
  const render = () => {
    const p = plan();
    clear(preview);
    if (!p.length) { preview.append(h('p.muted', 'Every part already has a unique designator.')); return; }
    preview.append(h('div.table-wrap', h('table.grid', h('thead', h('tr', h('th', 'Sheet'), h('th', 'Current'), h('th', 'New'))),
      h('tbody', p.map((x) => h('tr', h('td', project.getDoc(x.sheetId)?.name || ''), h('td', x.from || '(none)'), h('td', x.to)))))));
  };
  order.addEventListener('change', render);
  reset.addEventListener('change', render);
  render();
  await openDialog({
    title: 'Annotate schematics', size: 'wide',
    body: [
      h('div.form-grid', h('label', { for: order.id }, 'Order'), order, h('span'), h('label.check-row', reset, 'Renumber every part (otherwise only parts without a unique number)')),
      h('div', { style: { marginTop: '12px' } }, preview),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Annotate', primary: true,
      run: () => {
        const p = plan();
        const bySheet = new Map();
        for (const x of p) { if (!bySheet.has(x.sheetId)) bySheet.set(x.sheetId, []); bySheet.get(x.sheetId).push(x); }
        for (const [sheetId, list] of bySheet) {
          const doc = project.getDoc(sheetId);
          doc.store.transact('Annotate', (s) => { for (const x of list) s.update(x.id, { designator: x.to }); });
        }
        if (p.length) app.toast(`Annotated ${p.length} part${p.length === 1 ? '' : 's'}.`, { kind: 'success' });
        return true;
      },
    }],
  }).result;
}

// ---- Autorouter ----

export async function autorouteDialog(app, ed, nets = null) {
  const bar = h('div', { style: { width: '0%' } });
  const status = h('p', { 'aria-live': 'polite' }, 'Preparing...');
  let cancelled = false;
  const dlg = openDialog({
    title: nets ? `Autoroute ${nets.join(', ')}` : 'Autoroute all nets',
    body: [status, h('div.progress', { role: 'progressbar', 'aria-label': 'Routing progress' }, bar)],
    actions: [{ label: 'Stop', run: () => { cancelled = true; app.kernel.cancel(); return true; } }],
  });
  try {
    const t0 = performance.now();
    const res = await app.kernel.autoroute(ed.doc.snapshot(), ed.lib, { nets: nets || undefined, pourFills: ed.pourFills }, (p) => {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      bar.parentElement.setAttribute('aria-valuenow', String(pct));
      status.textContent = `${p.pass > 1 ? `Trying another order (pass ${p.pass}). ` : ''}Routing connection ${p.done} of ${p.total}...`;
    });
    dlg.close();
    if (!res.tracks.length && !res.vias.length) {
      app.toast(res.total ? 'The autorouter could not route any connection. Try more room, a finer grid or more layers.' : 'Nothing to route: every connection is already routed.', { kind: res.total ? 'warning' : 'info' });
      return;
    }
    ed.doc.store.transact('Autoroute', (s) => {
      for (const t of res.tracks) s.add({ t: 'track', ...t });
      for (const v of res.vias) s.add({ t: 'via', ...v });
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const failed = res.failed?.length || 0;
    app.toast(`Routed ${res.routed} of ${res.total} connections in ${secs} s${failed ? `; ${failed} could not be routed` : ''}${res.timedOut ? ' (time limit reached)' : ''}.`, { kind: failed ? 'warning' : 'success', title: 'Autoroute', timeout: 8000 });
  } catch (err) {
    dlg.close();
    if (!cancelled) app.toast(`Autorouting failed: ${err.message}`, { kind: 'error' });
  }
}

// ---- Fabrication export ----

export async function fabricationDialog(app, board) {
  const form = buildForm([
    { key: 'untentVias', label: 'Open vias in the solder mask (untented)', type: 'bool', value: false },
    { key: 'repour', label: 'Repour polygons before export', type: 'bool', value: true },
    { key: 'drc', label: 'Run the design rule check first', type: 'bool', value: true },
  ]);
  let result = null;
  await openDialog({
    title: `Fabrication files for ${board.name}`,
    body: [h('p', 'Creates a zip file with Gerber files for every layer, drill files, a bill of materials and a pick and place file, ready to send to a board maker.'), form.el],
    actions: [{ label: 'Cancel' }, { label: 'Create zip', primary: true, run: () => { result = form.values(); return true; } }],
  }).result;
  return result;
}

// ---- Help ----

export function shortcutsDialog(app) {
  const groups = new Map();
  for (const c of app.commands.map.values()) {
    if (!c.shortcut) continue;
    const g = c.context === 'sch' ? 'Schematic' : c.context === 'pcb' ? 'Board' : 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const extra = {
    General: [['Pan', 'Right or middle drag, or scroll'], ['Zoom', 'Ctrl+scroll, pinch, PageUp, PageDown'], ['Menu chords', 'Press a menu letter, then an item letter (P then W places a wire)'], ['Select box', 'Drag left to right for inside, right to left for touching'], ['Cycle stacked objects', 'Click again at the same spot'], ['Highlight a net', 'Ctrl+click']],
    Schematic: [['While placing', 'Space rotates, X / Y mirror, Tab edits'], ['While wiring', 'Shift+Space cycles corners, Backspace removes a corner']],
    Board: [['While routing', '* changes layer with a via, 3 cycles widths, Shift+Space cycles corners, Tab sets the width'], ['While moving', 'Space rotates, L flips to the other side']],
  };
  const body = h('div');
  for (const g of ['General', 'Schematic', 'Board']) {
    const rows = (groups.get(g) || []).sort((a, b) => a.label.localeCompare(b.label)).map((c) => h('tr', h('td', c.label), h('td', h('kbd.kbd-chip', c.shortcuts.map(shortcutLabel).join(' or ')))));
    const more = (extra[g] || []).map(([a, b]) => h('tr', h('td', a), h('td.muted', b)));
    body.append(h('h3', { style: { margin: '10px 0 6px', fontSize: 'var(--fs-md)' } }, g), h('table.grid.kbd-table', h('tbody', rows, more)));
  }
  openDialog({ title: 'Keyboard shortcuts', size: 'wide', body });
}

/** Searchable list of every command. */
export function commandPalette(app) {
  const input = h('input.palette-input', { type: 'text', placeholder: 'Type a command', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off' });
  const list = h('ul.palette-list#palette-list', { role: 'listbox' });
  let items = [];
  let sel = 0;
  const render = () => {
    const q = input.value.toLowerCase().trim();
    items = app.commands.available().filter((c) => c.id !== 'pcb.setCopper' && (!q || q.split(/\s+/).every((t) => `${c.label} ${c.id}`.toLowerCase().includes(t))))
      .filter((c) => !c.enabled || c.enabled()).slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    clear(list);
    items.forEach((c, i) => {
      const li = h('li', { role: 'option', id: `pal-${i}`, 'aria-selected': String(i === sel) }, c.icon ? icon(c.icon, 15) : h('span', { style: { width: '15px' } }), h('div.grow', c.label), c.shortcut ? h('kbd.kbd-chip', shortcutLabel(c.shortcut)) : null);
      li.addEventListener('click', () => run(i));
      li.addEventListener('pointermove', () => { if (sel !== i) { sel = i; render(); } });
      list.append(li);
    });
    input.setAttribute('aria-activedescendant', items.length ? `pal-${sel}` : '');
    if (!items.length) list.append(h('li.muted', 'No matching commands'));
  };
  let dlg;
  const run = (i) => { const c = items[i]; if (!c) return; dlg.close(); setTimeout(() => app.commands.run(c.id), 0); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(sel); }
  });
  render();
  dlg = openDialog({ title: 'Commands', body: [input, list], actions: [], initialFocus: () => input });
  dlg.body.style.padding = '0';
}

/** A short walkthrough of the design flow, from schematic to fabrication files. */
export function gettingStartedDialog(app) {
  const step = (n, title, text, cmd) => h('li', { style: { marginBottom: '10px' } },
    h('strong', `${n}. ${title}`), h('div.muted', { style: { margin: '2px 0 4px' } }, text),
    cmd ? h('button.btn.sm', { type: 'button', onClick: () => run(cmd) }, app.commands.get(cmd)?.label || 'Open') : null);
  const run = (cmd) => {
    dlg.close();
    if (!app.project) { app.toast('Create a project or open the example first.', { kind: 'info' }); return; }
    // Steps for the board or the schematic open that document first.
    const c = app.commands.get(cmd);
    if (c?.context && app.commands.context !== c.context) {
      const d = c.context === 'pcb' ? app.project.boards[0] : app.project.sheets[0];
      if (d) app.openDoc(d.id);
    }
    setTimeout(() => app.commands.run(cmd), 0);
  };
  const dlg = openDialog({
    title: 'Getting started', size: 'wide',
    body: [
      h('p', 'A board takes shape in a few steps. Each step is undoable, and the example project shows the result.'),
      h('ol', { style: { paddingLeft: '18px', margin: 0 } },
        step(1, 'Draw the schematic', 'Place parts from the Components panel, then connect pins with wires (Shift+W, or P then W). Name nets with net labels and power ports. Space rotates and X or Y mirrors while placing.', 'sch.place.part'),
        step(2, 'Check it', 'Compile runs the electrical rules check: unconnected pins, duplicate designators, conflicting outputs. Click a message to jump to the problem. Annotate numbers any parts still marked with a question mark.', 'project.compile'),
        step(3, 'Bring the parts to the board', 'Update board from schematic lists every change. New parts land beside the board with their nets assigned, connected by ratsnest lines.', 'project.updateBoard'),
        step(4, 'Shape the board and place parts', 'Set the board size, then drag parts onto it. Space rotates, L flips a part to the bottom side. The ratsnest follows as you move.', 'pcb.boardSize'),
        step(5, 'Route', 'Interactive routing (Shift+W) follows the corner style; * changes layer with a via, 3 cycles widths. The autorouter can route the rest.', 'pcb.route'),
        step(6, 'Pour copper and check', 'A ground pour connects pads with thermal reliefs. Rules are checked while you edit; run the full design rule check before export.', 'pcb.drc'),
        step(7, 'Export for manufacturing', 'The fabrication package holds Gerber files for every layer, drill files, a bill of materials and a pick and place file.', 'export.fabrication')),
      h('p.muted', 'Press ? for keyboard shortcuts and Ctrl+K to search every command.'),
    ],
    actions: [{ label: 'Open the example', left: true, run: () => { app.openExample(); return true; } }, { label: 'Close', primary: true }],
  });
}

export function aboutDialog(app) {
  openDialog({
    title: 'About Circuits',
    body: [
      h('p', h('strong', 'Circuits'), ' is a free, open-source app for schematic capture and printed circuit board layout. It is part of the Everything project and runs on Puter.'),
      h('p', 'Rendering uses WebGL2. Copper pours, design rule checks and autorouting run in a WebAssembly engine written in Rust, in a background worker so the editor stays responsive.'),
      h('p.muted', 'This is an early alpha. Check fabrication files carefully before ordering boards.'),
      h('p', h('a', { href: 'https://github.com/heyputer/everything', target: '_blank', rel: 'noopener noreferrer' }, 'Source code on GitHub'), ' . ', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener noreferrer' }, 'Built on Puter')),
    ],
  });
}

// ---- Projects ----

export async function openProjectDialog(app) {
  const listHost = h('div', h('p.muted', 'Loading projects...'));
  let dlg;
  const render = async () => {
    const [items, shared] = await Promise.all([listProjects(), sharedWithMe()]);
    clear(listHost);
    if (shared.length) {
      const ul = h('ul.recent-list', { style: { marginBottom: '14px' } });
      for (const it of shared) {
        const open = h('button', { type: 'button' }, icon('share', 16),
          h('span.grow', h('div', it.name), h('div.small.muted', `Shared by ${it.owner || 'someone'} . ${it.mode === 'read' ? 'view only' : 'can edit'}`)));
        open.addEventListener('click', () => { dlg.close(); app.openLocation(it.location); });
        ul.append(h('li', open));
      }
      listHost.append(h('h3', { style: { fontSize: 'var(--fs-md)', margin: '0 0 6px' } }, 'Shared with me'), ul, h('h3', { style: { fontSize: 'var(--fs-md)', margin: '0 0 6px' } }, 'My projects'));
    }
    if (!items.length) {
      listHost.append(h('p.muted', cloudAvailable() ? 'You have no saved projects yet.' : 'No projects are stored in this browser yet. Sign in to see projects saved in your Puter cloud.'));
      return;
    }
    const ul = h('ul.recent-list');
    for (const it of items) {
      const del = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${it.name}`, 'data-tip': 'Delete' }, icon('trash', 14));
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmDialog({ title: 'Delete project', message: `Delete ${it.name} permanently? This cannot be undone.`, confirm: 'Delete', danger: true })) {
          try { await deleteProject(it.location); render(); } catch (err) { app.toast(`Could not delete: ${err.message}`, { kind: 'error' }); }
        }
      });
      const open = h('button', { type: 'button' }, icon(it.location.type === 'cloud' ? 'cloud' : 'drive', 16),
        h('span.grow', h('div', it.name), h('div.small.muted', `${locationLabel(it.location)}${it.modified ? ` . ${new Date(it.modified).toLocaleString()}` : ''}`)));
      open.addEventListener('click', () => { dlg.close(); app.openLocation(it.location); });
      ul.append(h('li', { style: { display: 'flex', alignItems: 'center', paddingRight: '8px' } }, open, del));
    }
    listHost.append(ul);
  };
  dlg = openDialog({
    title: 'Open project', size: 'wide',
    body: listHost,
    actions: [
      { label: 'Open from this device...', left: true, run: () => { app.importFromDevice(); return true; } },
      cloudAvailable() ? { label: 'Browse Puter files...', left: true, run: () => { app.openFromCloudPicker(); return true; } } : null,
      { label: 'Close' },
    ].filter(Boolean),
  });
  render();
  return dlg.result;
}

export async function preferencesDialog(app) {
  const s = app.settings;
  const form = buildForm([
    { key: 'theme', label: 'Theme', type: 'select', value: s.get('theme'), options: [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']] },
    { key: 'units', label: 'Units', type: 'select', value: s.get('units'), options: [['mm', 'Millimetres'], ['mil', 'Mils (thousandths of an inch)']] },
    { key: 'wheel', label: 'Mouse wheel', type: 'select', value: s.get('wheel'), options: [['scroll', 'Scrolls (Ctrl+wheel zooms)'], ['zoom', 'Zooms']] },
    { key: 'routingMode', label: 'Interactive routing', type: 'select', value: s.get('routingMode'), options: [['stop', 'Stop at the first obstacle'], ['ignore', 'Ignore obstacles']] },
    { key: 'autosaveMinutes', label: 'Autosave every (minutes, 0 = off)', type: 'number', value: s.get('autosaveMinutes'), min: 0, max: 60 },
    { key: 'onlineDrc', label: 'Check design rules while editing', type: 'bool', value: s.get('onlineDrc') },
    { key: 'autoRepour', label: 'Repour polygons automatically', type: 'bool', value: s.get('autoRepour') },
    { key: 'padLabels', label: 'Show net names on pads', type: 'bool', value: s.get('padLabels') },
    { key: 'showHud', label: 'Show the heads-up coordinate display', type: 'bool', value: s.get('showHud') },
    { key: 'pcbCrosshair', label: 'Full crosshair cursor on boards', type: 'bool', value: !!s.get('pcbCrosshair') },
    { key: 'schCrosshair', label: 'Crosshair cursor on schematics', type: 'bool', value: !!s.get('schCrosshair') },
  ]);
  await openDialog({
    title: 'Preferences',
    body: form.el,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true,
      run: () => {
        if (form.validate()) return false;
        const v = form.values();
        for (const [k, val] of Object.entries(v)) s.set(k, val);
        app.applyPreferences();
        return true;
      },
    }],
  }).result;
}

export function boardInfoDialog(app, ed) {
  const u = app.settings.get('units');
  const items = [...ed.doc.items()];
  const count = (t) => items.filter((o) => o.t === t).length;
  const bb = bboxOfFlat(ed.doc.board.outline);
  const a = ed.analysis();
  const unrouted = [...a.unrouted.values()].reduce((x, y) => x + y, 0);
  let trackLen = 0;
  for (const o of items) if (o.t === 'track') trackLen += Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  const pads = items.filter((o) => o.t === 'comp').reduce((n, o) => n + (ed.lib[o.comp]?.footprint?.pads.length || 0), 0);
  const rows = [
    ['Size', `${formatLength(bb.maxX - bb.minX, u)} x ${formatLength(bb.maxY - bb.minY, u)}`],
    ['Area', `${(Math.abs(polyArea(ed.doc.board.outline)) / 1e12).toFixed(1)} mm2`],
    ['Copper layers', String(ed.copperCount)],
    ['Components', String(count('comp'))],
    ['Pads', String(pads + count('pad'))],
    ['Vias', String(count('via'))],
    ['Track segments', `${count('track')} (${formatLength(trackLen, u)} total)`],
    ['Polygon pours', String(count('pour'))],
    ['Nets', String(Object.keys(ed.doc.nets).length)],
    ['Unrouted connections', String(unrouted)],
    ['Rule violations', String(ed.violations.length)],
  ];
  openDialog({ title: `Board information: ${ed.doc.name}`, body: h('table.grid', h('tbody', rows.map(([k, v]) => h('tr', h('td', k), h('td', v))))) });
}

/** Find components and nets by designator, value or name. */
export function findDialog(app) {
  const ed = app.activeEditor;
  const input = h('input.palette-input', { type: 'text', placeholder: 'Designator, value or net name', 'aria-label': 'Find', autocomplete: 'off' });
  const list = h('ul.palette-list', { role: 'listbox' });
  let results = [];
  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    results = [];
    if (q) {
      for (const o of ed.doc.items()) {
        if ((o.t === 'part' || o.t === 'comp') && (o.designator?.toLowerCase().includes(q) || (o.value || '').toLowerCase().includes(q))) results.push({ label: `${o.designator} ${o.value || ''}`, kind: 'Component', go: () => ed.focusObject(o.id) });
        else if ((o.t === 'label' && o.text.toLowerCase().includes(q)) || (o.t === 'text' && o.text.toLowerCase().includes(q))) results.push({ label: o.text, kind: o.t === 'label' ? 'Net label' : 'Text', go: () => ed.focusObject(o.id) });
      }
      const nets = ed.kind === 'pcb' ? Object.keys(ed.doc.nets) : app.project.netlist().nets.map((n) => n.name);
      for (const n of nets) if (n.toLowerCase().includes(q)) results.push({ label: n, kind: 'Net', go: () => ed.highlightNet(n) });
    }
    results = results.slice(0, 80);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    clear(list);
    results.forEach((r, i) => {
      const li = h('li', { role: 'option', 'aria-selected': String(i === sel) }, h('div.grow', r.label), h('span.path', r.kind));
      li.addEventListener('click', () => go(i));
      list.append(li);
    });
    if (q && !results.length) list.append(h('li.muted', 'Nothing found'));
  };
  let dlg;
  const go = (i) => { const r = results[i]; if (!r) return; dlg.close(); r.go(); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(sel); }
  });
  dlg = openDialog({ title: `Find in ${ed.doc.name}`, body: [input, list], actions: [], initialFocus: () => input });
  dlg.body.style.padding = '0';
}
