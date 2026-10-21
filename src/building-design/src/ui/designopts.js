/**
 * Design options dialogs: create sets and options, choose which option to
 * edit, make one primary or accept it, and choose what each view shows.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast, promptDialog, confirmDialog } from './dialog.js';
import { optionSets, optionsOf, primaryOf, newOptionSet, makePrimary, deleteOption, acceptPrimary, editingOption, optionable, optionLabel } from '../core/designopts.js';
import { uniqueName } from '../core/ops.js';

export function designOptionsDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const count = (id) => doc.filter((x) => x.optionId === id).length;
  const render = () => {
    clear(body);
    const sets = optionSets(doc);
    const editing = editingOption();
    body.append(
      h('p.dialog-text', 'Explore alternatives for part of the design. Each option set holds options; views show the primary option unless they choose another. Edit an option to add elements to it.'),
      h('div.dopt-current', icon('designOptions', 16), h('span', 'Editing: ', h('strong', optionLabel(doc, editing))), editing ? h('button.btn.sm', { type: 'button', onClick: () => (app.editOption(null), render()) }, 'Finish editing') : null),
    );
    for (const set of sets) {
      const list = h('ul.dopt-list', { role: 'list' });
      for (const o of optionsOf(doc, set.id)) {
        const isEditing = editing === o.id;
        list.append(
          h('li.dopt-item', { class: isEditing ? 'editing' : null },
            h('span.dopt-name', o.name, o.primary ? h('span.badge', 'Primary') : null),
            h('span.file-meta', `${count(o.id)} element${count(o.id) === 1 ? '' : 's'}`),
            h('span.inline',
              h('button.btn.sm', { type: 'button', disabled: isEditing, onClick: () => (app.editOption(o.id), render()) }, isEditing ? 'Editing' : 'Edit'),
              h('button.btn.sm', { type: 'button', disabled: o.primary, onClick: () => (app.commit('Make primary', () => makePrimary(doc, o.id)), render()) }, 'Make Primary'),
              h('button.icon-btn.sm', { type: 'button', 'aria-label': `Rename ${o.name}`, onClick: async () => {
                const n = await promptDialog('Rename Option', 'Name', o.name, { okLabel: 'Rename' });
                if (n) app.commit('Rename option', () => doc.update(o.id, { name: n }));
                render();
              } }, icon('pencil', 14)),
              h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${o.name}`, onClick: async () => {
                if (!(await confirmDialog('Delete option?', `${o.name} and its ${count(o.id)} elements will be deleted.`, { confirm: 'Delete', danger: true }))) return;
                if (editingOption() === o.id) app.editOption(null);
                app.commit('Delete option', () => deleteOption(doc, o.id));
                render();
              } }, icon('trash', 14)))),
        );
      }
      body.append(
        h('section.dopt-set',
          h('div.dopt-head',
            h('h3.dlg-sub', set.name),
            h('span.grow'),
            h('button.btn.sm', { type: 'button', onClick: () => {
              let o;
              app.commit('New option', () => (o = doc.add({ kind: 'designOption', setId: set.id, name: uniqueName(optionsOf(doc, set.id).map((x) => x.name), 'Option 2'), primary: false })));
              app.editOption(o.id);
              render();
            } }, icon('plus', 14), 'New Option'),
            h('button.btn.sm', { type: 'button', onClick: async () => {
              const p = primaryOf(doc, set.id);
              if (!(await confirmDialog('Accept primary option?', `${p?.name ?? 'The primary option'} becomes part of the main model, and the other options of ${set.name} are deleted with their elements.`, { confirm: 'Accept Primary' }))) return;
              if (optionsOf(doc, set.id).some((o) => o.id === editingOption())) app.editOption(null);
              app.commit('Accept primary', () => acceptPrimary(doc, set.id));
              render();
            } }, 'Accept Primary')),
          list),
      );
    }
    body.append(
      h('button.btn', { type: 'button', onClick: async () => {
        const name = await promptDialog('New Option Set', 'Name (what the options are alternatives for)', uniqueName(sets.map((s) => s.name), 'Option Set 1'), { okLabel: 'Create' });
        if (!name) return;
        let made;
        app.commit('New option set', () => (made = newOptionSet(doc, name)));
        app.editOption(made.opt.id);
        render();
      } }, icon('plus', 14), 'New Option Set'),
    );
  };
  render();
  return openDialog({ title: 'Design Options', body, size: 'md', actions: [{ label: 'Close', primary: true, value: true }] });
}

/** Move the selected main-model elements into the option being edited. */
export function addToOption(app) {
  const doc = app.doc;
  const target = editingOption();
  if (!target) return toast('Edit a design option first (status bar or Design Options).', { kind: 'error' });
  const ids = [...app.selection].filter((id) => optionable(doc, doc.get(id)));
  if (!ids.length) return toast('Select model elements to add to the option.', { kind: 'error' });
  app.commit('Add to design option', () => ids.forEach((id) => doc.update(id, { optionId: target })));
  toast(`Moved ${ids.length} element${ids.length === 1 ? '' : 's'} to ${optionLabel(doc, target)}.`, { kind: 'success' });
}

/** Which option of each set a view shows. */
export function viewOptionsDialog(app, view = app.activeView) {
  const doc = app.doc;
  if (!view) return;
  const state = { ...(view.designOptions || {}) };
  const tbody = h('tbody');
  for (const set of optionSets(doc)) {
    const sel = h('select.input.sm', { 'aria-label': `${set.name} in this view` }, h('option', { value: '' }, `Automatic (${primaryOf(doc, set.id)?.name ?? 'primary'})`), optionsOf(doc, set.id).map((o) => h('option', { value: o.id }, o.name)));
    sel.value = state[set.id] || '';
    sel.addEventListener('change', () => {
      if (sel.value) state[set.id] = sel.value;
      else delete state[set.id];
    });
    tbody.append(h('tr', h('td', set.name), h('td', sel)));
  }
  return openDialog({
    title: `Design Options in ${view.name}`,
    size: 'sm',
    body: h('div', h('table.vg-table', h('thead', h('tr', h('th', 'Option set'), h('th', 'Shows'))), tbody), h('p.field-hint', 'The option being edited is always shown.')),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: () => app.commit('View design options', () => doc.update(view.id, { designOptions: state })) },
    ],
  });
}
