/**
 * Manage-tab dialogs: phases, object styles, project parameters, saved
 * selections, selection inquiry (IDs) and warnings.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast, promptDialog, confirmDialog } from './dialog.js';
import { CATEGORIES } from '../core/catalog.js';
import { phasesInOrder } from '../core/phases.js';
import { PARAM_TYPES, PARAM_GROUPS, projectParams } from '../core/params.js';
import { uniqueName } from '../core/ops.js';
import { modelWarnings } from '../core/warnings.js';
import { isView } from '../core/doc.js';

function field(label, control) {
  return h('label.field', h('span.field-label', label), control);
}

// Phases ------------------------------------------------------------------------------------------

export function phasesDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    const phases = phasesInOrder(doc);
    const list = h('ol.phase-list');
    phases.forEach((p, i) => {
      const name = h('input.input.sm', { type: 'text', value: p.name, 'aria-label': `Name of phase ${i + 1}` });
      name.addEventListener('change', () => name.value.trim() && app.commit('Rename phase', () => doc.update(p.id, { name: name.value.trim() })));
      const swap = (j) => {
        const q = phases[j];
        app.commit('Reorder phases', () => {
          doc.update(p.id, { order: q.order });
          doc.update(q.id, { order: p.order });
        });
        render();
      };
      const used = doc.filter((el) => el.phaseId === p.id || el.demolishedId === p.id).length;
      list.append(
        h(
          'li.inline',
          h('span.phase-num', String(i + 1)),
          name,
          h('span.file-meta', used ? `${used} element${used === 1 ? '' : 's'}` : ''),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': `Move ${p.name} earlier`, disabled: i === 0, onClick: () => swap(i - 1) }, icon('chevron-up', 14)),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': `Move ${p.name} later`, disabled: i === phases.length - 1, onClick: () => swap(i + 1) }, icon('chevron-down', 14)),
          h(
            'button.icon-btn.sm',
            {
              type: 'button',
              'aria-label': `Delete ${p.name}`,
              disabled: phases.length <= 1,
              onClick: async () => {
                const next = phases[i + 1] || phases[i - 1];
                if (used && !(await confirmDialog('Delete phase', `Elements of "${p.name}" move to "${next.name}".`, { confirm: 'Delete', danger: true }))) return;
                app.commit('Delete phase', () => {
                  for (const el of doc.items.values()) {
                    if (el.phaseId === p.id) doc.update(el.id, { phaseId: next.id });
                    if (el.demolishedId === p.id) doc.update(el.id, { demolishedId: null });
                  }
                  doc.remove(p.id);
                });
                render();
              },
            },
            icon('trash', 14),
          ),
        ),
      );
    });
    body.append(
      h('p.field-hint', 'Phases run from first to last. Elements are created in a phase and can be demolished in a later one; each view shows the model as of its phase.'),
      list,
      h(
        'button.btn.sm',
        {
          type: 'button',
          onClick: () => {
            const names = phases.map((p) => p.name);
            const order = (phases.at(-1)?.order || 0) + 1;
            app.commit('Add phase', () => doc.add({ kind: 'phase', name: uniqueName(names, `Phase ${phases.length + 1}`), order }));
            render();
          },
        },
        icon('plus', 14),
        'Add phase',
      ),
    );
  };
  render();
  return openDialog({ title: 'Phases', body, size: 'md', actions: [{ label: 'Close', primary: true, value: null }] });
}

// Object styles -----------------------------------------------------------------------------------

const WEIGHTS = [
  { value: '', label: 'Default' },
  { value: '1', label: '1 Fine' },
  { value: '2', label: '2 Light' },
  { value: '3', label: '3 Medium' },
  { value: '4', label: '4 Cut' },
  { value: '5', label: '5 Heavy' },
];

export function objectStylesDialog(app) {
  const doc = app.doc;
  const styles = structuredClone(doc.get('project')?.objectStyles || {});
  const tbody = h('tbody');
  for (const c of CATEGORIES) {
    const s = styles[c.id] || (styles[c.id] = {});
    const color = h('input.ov-color', { type: 'color', value: s.color || '#000000', 'aria-label': `${c.label} line color` });
    const wrap = h('div.ov-colorcell', { class: s.color ? 'set' : '' }, color);
    const reset = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Reset ${c.label} color`, hidden: !s.color }, icon('x', 12));
    wrap.append(reset);
    color.addEventListener('input', () => {
      s.color = color.value;
      wrap.classList.add('set');
      reset.hidden = false;
    });
    reset.addEventListener('click', () => {
      s.color = null;
      wrap.classList.remove('set');
      reset.hidden = true;
    });
    const weight = h('select.input.sm', { 'aria-label': `${c.label} line weight` }, WEIGHTS.map((w) => h('option', { value: w.value }, w.label)));
    weight.value = s.weight ? String(s.weight) : '';
    weight.addEventListener('change', () => (s.weight = weight.value ? +weight.value : null));
    tbody.append(h('tr', h('td', c.label), h('td', c.model ? 'Model' : 'Annotation'), h('td', wrap), h('td', weight)));
  }
  return openDialog({
    title: 'Object Styles',
    body: h('div', h('p.field-hint', 'The default line color and weight of each category in every view. Views can override them in Visibility/Graphics.'), h('div.vg-panel', h('table.vg-table', h('thead', h('tr', h('th', 'Category'), h('th', 'Kind'), h('th', 'Line color'), h('th', 'Line weight'))), tbody))),
    size: 'lg',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          const out = {};
          for (const [k, v] of Object.entries(styles)) if (v.color || v.weight) out[k] = { ...(v.color ? { color: v.color } : {}), ...(v.weight ? { weight: v.weight } : {}) };
          doc.setInfo({ objectStyles: Object.keys(out).length ? out : null });
        },
      },
    ],
  });
}

// Project parameters ------------------------------------------------------------------------------

export function projectParamsDialog(app) {
  const doc = app.doc;
  let current = projectParams(doc)[0]?.id ?? null;
  const side = h('div.style-side');
  const main = h('div.style-main');
  const render = () => {
    clear(side);
    clear(main);
    const list = h('ul.style-list', { role: 'listbox', 'aria-label': 'Project parameters' });
    for (const p of projectParams(doc)) list.append(h('li.style-item', { role: 'option', 'aria-selected': String(p.id === current), tabindex: '0', onClick: () => ((current = p.id), render()), onKeydown: (e) => e.key === 'Enter' && ((current = p.id), render()) }, p.name));
    side.append(
      list,
      h(
        'div.inline',
        h(
          'button.btn.sm',
          {
            type: 'button',
            onClick: async () => {
              const names = projectParams(doc).map((p) => p.name);
              const name = await promptDialog('New Project Parameter', 'Name', uniqueName(names, 'Fire Rating'), { okLabel: 'Add', validate: (v) => (!v ? 'Enter a name.' : names.includes(v) ? 'A parameter with this name exists.' : null) });
              if (!name) return;
              let p;
              app.commit('Add project parameter', () => (p = doc.add({ kind: 'projectParam', name, type: 'text', categories: ['walls', 'doors'], group: 'Identity Data' })));
              current = p.id;
              render();
            },
          },
          icon('plus', 14),
          'New',
        ),
        current
          ? h(
              'button.btn.sm',
              {
                type: 'button',
                onClick: () => {
                  app.commit('Delete project parameter', () => {
                    for (const el of doc.items.values())
                      if (el.params && current in el.params) {
                        const { [current]: _drop, ...rest } = el.params;
                        void _drop;
                        doc.update(el.id, { params: rest });
                      }
                    doc.remove(current);
                  });
                  current = projectParams(doc)[0]?.id ?? null;
                  render();
                },
              },
              icon('trash', 14),
              'Delete',
            )
          : null,
      ),
    );
    const p = doc.get(current);
    if (!p) {
      main.append(h('p.props-empty', 'Add your own parameters to categories of elements, such as a fire rating for walls and doors. They show in the properties palette, in schedules and in filters.'));
      return;
    }
    const save = (patch) => app.commit('Edit project parameter', () => doc.update(p.id, patch));
    const name = h('input.input', { type: 'text', value: p.name });
    name.addEventListener('change', () => name.value.trim() && (save({ name: name.value.trim() }), render()));
    const type = h('select.input', {}, PARAM_TYPES.map((t) => h('option', { value: t.value }, t.label)));
    type.value = p.type;
    type.addEventListener('change', () => save({ type: type.value }));
    const group = h('select.input', {}, PARAM_GROUPS.map((g) => h('option', { value: g }, g)));
    group.value = p.group || 'Identity Data';
    group.addEventListener('change', () => save({ group: group.value }));
    const cats = h('div.snap-grid');
    for (const c of CATEGORIES.filter((x) => x.model || ['rooms', 'areas'].includes(x.id))) {
      const cb = h('input', { type: 'checkbox', checked: p.categories?.includes(c.id) });
      cb.addEventListener('change', () => {
        const set = new Set(doc.get(p.id).categories || []);
        if (cb.checked) set.add(c.id);
        else set.delete(c.id);
        save({ categories: [...set] });
      });
      cats.append(h('label.check', cb, c.label));
    }
    main.append(h('div.row2', field('Name', name), field('Type', type)), field('Group in properties', group), h('h3.dlg-sub', 'Categories'), cats);
  };
  render();
  return openDialog({ title: 'Project Parameters', body: h('div.style-dlg', side, main), size: 'lg', actions: [{ label: 'Close', primary: true, value: null }] });
}

// Selections --------------------------------------------------------------------------------------

export async function saveSelection(app) {
  const ids = [...app.selection];
  if (!ids.length) return toast('Select elements first.', { kind: 'error' });
  const names = app.doc.all('selectionSet').map((s) => s.name);
  const name = await promptDialog('Save Selection', 'Name', uniqueName(names, 'Selection 1'), { okLabel: 'Save', validate: (v) => (!v ? 'Enter a name.' : null) });
  if (!name) return;
  const existing = app.doc.all('selectionSet').find((s) => s.name === name);
  app.commit('Save selection', () => (existing ? app.doc.update(existing.id, { ids }) : app.doc.add({ kind: 'selectionSet', name, ids })));
  toast(`Saved ${ids.length} element${ids.length === 1 ? '' : 's'} as "${name}".`, { kind: 'success' });
}

export function loadSelection(app) {
  const doc = app.doc;
  const sets = doc.all('selectionSet');
  if (!sets.length) return toast('No saved selections. Select elements and use Save.', { kind: 'error' });
  const body = h('div');
  const render = () => {
    clear(body);
    const list = h('ul.find-list');
    for (const s of doc.all('selectionSet')) {
      const live = s.ids.filter((id) => doc.has(id));
      list.append(
        h(
          'li.inline',
          h(
            'button.find-item',
            {
              type: 'button',
              onClick: () => {
                app.select(live);
                body.closest('dialog')?._close?.(null);
              },
            },
            h('span.find-text', s.name),
            h('span.find-view', `${live.length} element${live.length === 1 ? '' : 's'}`),
          ),
          h('button.btn.sm', { type: 'button', disabled: !app.selection.size, 'data-tip': 'Add the current selection', onClick: () => (app.commit('Edit selection', () => doc.update(s.id, { ids: [...new Set([...s.ids, ...app.selection])] })), render()) }, 'Add'),
          h('button.btn.sm', { type: 'button', disabled: !app.selection.size, 'data-tip': 'Remove the current selection', onClick: () => (app.commit('Edit selection', () => doc.update(s.id, { ids: s.ids.filter((id) => !app.selection.has(id)) })), render()) }, 'Remove'),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${s.name}`, onClick: () => (app.commit('Delete selection', () => doc.remove(s.id)), render()) }, icon('trash', 14)),
        ),
      );
    }
    body.append(list);
  };
  render();
  return openDialog({ title: 'Saved Selections', body, size: 'md', actions: [{ label: 'Close', primary: true, value: null }] });
}

export function idsOfSelection(app) {
  const ids = [...app.selection];
  if (!ids.length) return toast('Select elements first.', { kind: 'error' });
  const ta = h('textarea.input', { rows: 6, readonly: true, 'aria-label': 'IDs of the selection' });
  ta.value = ids.join('\n');
  return openDialog({
    title: 'IDs of Selection',
    body: h('div', ta),
    size: 'sm',
    actions: [
      { label: 'Copy', onClick: () => (navigator.clipboard?.writeText(ta.value), toast('Copied.'), false) },
      { label: 'Close', primary: true, value: null },
    ],
  });
}

export async function selectById(app) {
  const text = await promptDialog('Select by ID', 'IDs (separated by commas or spaces)', '', { okLabel: 'Select' });
  if (!text) return;
  const ids = text.split(/[\s,;]+/).filter(Boolean);
  const found = ids.filter((id) => app.doc.has(id) && !isView(app.doc.get(id)));
  app.select(found);
  if (found.length) app.vc?.zoomExtents?.(true, new Set(found));
  toast(found.length === ids.length ? `Selected ${found.length}.` : `Found ${found.length} of ${ids.length}.`, { kind: found.length ? 'success' : 'error' });
}

// Warnings ----------------------------------------------------------------------------------------

export function warningsDialog(app) {
  const ws = modelWarnings(app.doc, app.scene);
  const body = h('div');
  if (!ws.length) body.append(h('p.props-empty', 'No warnings. The model has no overlapping walls, unenclosed rooms or duplicate marks.'));
  else {
    const list = h('ul.find-list.warn-list');
    for (const w of ws.slice(0, 500))
      list.append(
        h(
          'li',
          h(
            'button.find-item',
            {
              type: 'button',
              onClick: () => {
                const live = w.ids.filter((id) => app.doc.has(id));
                const first = app.doc.get(live[0]);
                const plan = first?.levelId && app.doc.all('plan').find((p) => p.levelId === first.levelId && !p.calloutOf);
                if (plan && app.activeView?.levelId !== first.levelId) app.openView(plan.id);
                app.select(live);
                app.vc?.zoomExtents?.(true, new Set(live));
              },
            },
            icon('warning', 14),
            h('span.find-text', w.message),
            h('span.find-view', `${w.ids.length} element${w.ids.length === 1 ? '' : 's'}`),
          ),
        ),
      );
    body.append(h('p.field-hint', `${ws.length} warning${ws.length === 1 ? '' : 's'}. Click one to select and show its elements.`), list);
  }
  return openDialog({ title: 'Warnings', body, size: 'md', actions: [{ label: 'Close', primary: true, value: null }] });
}
