/**
 * Global parameters dialog, and associating element parameters with them
 * from the Properties panel.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './dialog.js';
import { showMenu } from './menu.js';
import { globalValues, deleteGlobal } from '../core/globals.js';
import { formatLength, parseLength } from '../core/units.js';
import { uniqueName } from '../core/ops.js';

const fmt = (doc, p, v) => (p.type === 'length' ? formatLength(v, doc.units) : String(Math.round(v * 1000) / 1000));

export function globalParamsDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    const params = doc.all('globalParam');
    const values = globalValues(doc);
    const uses = new Map();
    for (const el of doc.filter((x) => x.bindings)) for (const g of Object.values(el.bindings)) uses.set(g, (uses.get(g) || 0) + 1);
    const tbody = h('tbody');
    for (const p of params) {
      const r = values.get(p.id);
      const name = h('input.input.sm', { type: 'text', value: p.name, 'aria-label': 'Name' });
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v || !/^[A-Za-z_][\w ]*$/.test(v)) return toast('Names start with a letter and use letters, digits, spaces and underscores.', { kind: 'error' });
        app.commit('Rename global parameter', () => doc.update(p.id, { name: v }));
        render();
      });
      const value = h('input.input.sm', { type: 'text', value: fmt(doc, p, r.value), disabled: !!p.formula, 'aria-label': `${p.name} value` });
      value.addEventListener('change', () => {
        const v = p.type === 'length' ? parseLength(value.value, doc.units) : parseFloat(value.value);
        if (!Number.isFinite(v)) return toast('That is not a valid value.', { kind: 'error' });
        app.commit('Global parameter', () => doc.update(p.id, { value: v }));
        render();
      });
      const formula = h('input.input.sm', { type: 'text', value: p.formula || '', placeholder: 'e.g. Floor Height - 300', 'aria-label': `${p.name} formula`, 'aria-invalid': r.error ? 'true' : null });
      formula.addEventListener('change', () => {
        app.commit('Global parameter formula', () => doc.update(p.id, { formula: formula.value.trim() || null }));
        render();
      });
      tbody.append(
        h('tr',
          h('td', name),
          h('td.muted', p.type === 'length' ? 'Length' : 'Number'),
          h('td', value),
          h('td', formula, r.error ? h('div.field-error', r.error) : null),
          h('td.num', String(uses.get(p.id) || 0)),
          h('td', h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${p.name}`, onClick: () => (app.commit('Delete global parameter', () => deleteGlobal(doc, p.id)), render()) }, icon('trash', 14)))),
      );
    }
    const add = (type) => {
      const names = params.map((p) => p.name);
      app.commit('New global parameter', () => doc.add({ kind: 'globalParam', name: uniqueName(names, type === 'length' ? 'Length 1' : 'Number 1'), type, value: type === 'length' ? 3000 : 1 }));
      render();
    };
    body.append(
      params.length
        ? h('div.kbd-scroll', h('table.vg-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Type'), h('th', 'Value'), h('th', 'Formula'), h('th.num', 'Used by'), h('th', h('span.sr-only', 'Delete')))), tbody))
        : h('p.dialog-text', 'Global parameters are named values, such as a floor-to-floor height or a module width, that element parameters can follow. Associate a parameter from the Properties panel with the link button next to a length.'),
      h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } }, h('button.btn', { type: 'button', onClick: () => add('length') }, icon('plus', 14), 'Length'), h('button.btn', { type: 'button', onClick: () => add('number') }, icon('plus', 14), 'Number')),
    );
  };
  render();
  return openDialog({ title: 'Global Parameters', body, size: 'lg', actions: [{ label: 'Close', primary: true, value: true }] });
}

/** Menu for the link button next to a property: associate it with a global parameter, or not. */
export function bindingMenu(app, anchor, p, items) {
  const doc = app.doc;
  const values = globalValues(doc);
  const type = p.type === 'length' ? 'length' : 'number';
  const current = items[0]?.bindings?.[p.key] ?? null;
  const set = (gid) =>
    app.commit(gid ? 'Associate global parameter' : 'Dissociate global parameter', () => {
      for (const el of items) {
        const b = { ...(doc.get(el.id).bindings || {}) };
        if (gid) b[p.key] = gid;
        else delete b[p.key];
        doc.update(el.id, { bindings: Object.keys(b).length ? b : null });
      }
    });
  const params = doc.all('globalParam').filter((g) => g.type === type);
  showMenu(
    anchor,
    [
      { header: `Associate ${p.label} with` },
      { label: 'None', checked: !current, radio: true, action: () => set(null) },
      ...params.map((g) => ({ label: `${g.name} (${fmt(doc, g, values.get(g.id)?.value ?? 0)})`, checked: current === g.id, radio: true, action: () => set(g.id) })),
      { separator: true },
      { label: 'Global Parameters...', icon: 'globalParams', action: () => app.run('globalParams') },
    ],
    { label: 'Global parameter' },
  );
}
