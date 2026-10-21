/**
 * Collaboration dialogs: worksets, per-view workset visibility,
 * synchronizing with a comment and the synchronization history.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast, promptDialog } from './dialog.js';
import { worksets, worksharingOn, enableWorksharing, deleteWorkset, worksetColor, worksetOf, worksetable } from '../core/worksets.js';
import { syncLog } from '../io/sync.js';
import { uniqueName } from '../core/ops.js';

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function worksetsDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    if (!worksharingOn(doc)) {
      body.append(
        h('p.dialog-text', 'Worksets divide the model into parts that people work on, such as the shell, the interiors and the site. Each view chooses which worksets it shows, and new elements go into your active workset.'),
        h('p.dialog-text', 'Turning worksets on puts levels and grids into "Shared Levels and Grids" and everything else into "Workset1".'),
        h('button.btn.primary', { type: 'button', onClick: () => (app.commit('Enable worksets', () => enableWorksharing(doc)), (app.activeWorksetId = null), render()) }, icon('worksets', 16), 'Turn on worksets'),
      );
      return;
    }
    const counts = new Map();
    for (const el of doc.items.values()) if (worksetable(doc, el)) counts.set(worksetOf(doc, el)?.id, (counts.get(worksetOf(doc, el)?.id) || 0) + 1);
    const active = app.activeWorkset()?.id;
    const tbody = h('tbody');
    for (const w of worksets(doc)) {
      const name = h('input.input.sm', { type: 'text', value: w.name, 'aria-label': 'Workset name' });
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (v && v !== w.name) app.commit('Rename workset', () => doc.update(w.id, { name: v }));
        render();
      });
      const vis = h('input', { type: 'checkbox', checked: w.visibleByDefault !== false, 'aria-label': `Show ${w.name} in all views by default` });
      vis.addEventListener('change', () => app.commit('Workset visibility', () => doc.update(w.id, { visibleByDefault: vis.checked })));
      const radio = h('input', { type: 'radio', name: 'ws-active', checked: w.id === active, 'aria-label': `Make ${w.name} the active workset` });
      radio.addEventListener('change', () => app.setActiveWorkset(w.id));
      const del = h('button.icon-btn.sm', {
        type: 'button',
        'aria-label': `Delete ${w.name}`,
        'data-tip': 'Delete (its elements move to another workset)',
        disabled: worksets(doc).length <= 1 || w.shared,
        onClick: () => {
          const to = worksets(doc).find((x) => x.id !== w.id && !x.shared) || worksets(doc).find((x) => x.id !== w.id);
          app.commit('Delete workset', () => deleteWorkset(doc, w.id, to.id));
          toast(`Deleted ${w.name}. Its elements moved to ${to.name}.`);
          render();
        },
      }, icon('trash', 14));
      tbody.append(h('tr', h('td', radio), h('td', h('span.ws-swatch', { style: { background: worksetColor(doc, w.id) } })), h('td', name), h('td.num', String(counts.get(w.id) || 0)), h('td', vis), h('td', del)));
    }
    body.append(
      h('table.vg-table', h('thead', h('tr', h('th', 'Active'), h('th', h('span.sr-only', 'Colour')), h('th', 'Name'), h('th', 'Elements'), h('th', 'Visible by default'), h('th', h('span.sr-only', 'Delete')))), tbody),
      h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
        h('button.btn', { type: 'button', onClick: async () => {
          const n = await promptDialog('New Workset', 'Name', uniqueName(worksets(doc).map((w) => w.name), 'Workset1'), { okLabel: 'Create' });
          if (!n) return;
          let w;
          app.commit('New workset', () => (w = doc.add({ kind: 'workset', name: n, visibleByDefault: true })));
          app.setActiveWorkset(w.id);
          render();
        } }, icon('plus', 14), 'New'),
        h('button.btn', { type: 'button', disabled: !app.selection.size, onClick: () => {
          const ids = [...app.selection].filter((id) => worksetable(doc, doc.get(id)));
          const to = app.activeWorkset();
          if (!ids.length || !to) return;
          app.commit('Move to workset', () => ids.forEach((id) => doc.update(id, { worksetId: to.id })));
          toast(`Moved ${ids.length} element${ids.length === 1 ? '' : 's'} to ${to.name}.`);
          render();
        } }, 'Move selection to active'),
      ),
      h('p.field-hint', 'Colours are used when a view\'s Worksharing Display is set to colour by workset.'),
    );
  };
  render();
  return openDialog({ title: 'Worksets', body, size: 'md', actions: [{ label: 'Close', primary: true, value: true }] });
}

/** Which worksets a view shows. */
export function viewWorksetsDialog(app, view = app.activeView) {
  const doc = app.doc;
  if (!view) return;
  const state = { ...(view.worksets || {}) };
  const tbody = h('tbody');
  for (const w of worksets(doc)) {
    const def = w.visibleByDefault !== false;
    const sel = h('select.input.sm', { 'aria-label': `${w.name} in this view` },
      h('option', { value: '' }, `Use default (${def ? 'shown' : 'hidden'})`),
      h('option', { value: 'show' }, 'Show'),
      h('option', { value: 'hide' }, 'Hide'));
    sel.value = w.id in state ? (state[w.id] ? 'show' : 'hide') : '';
    sel.addEventListener('change', () => {
      if (!sel.value) delete state[w.id];
      else state[w.id] = sel.value === 'show';
    });
    tbody.append(h('tr', h('td', h('span.ws-swatch', { style: { background: worksetColor(doc, w.id) } })), h('td', w.name), h('td', sel)));
  }
  return openDialog({
    title: `Worksets in ${view.name}`,
    body: h('table.vg-table', h('thead', h('tr', h('th', h('span.sr-only', 'Colour')), h('th', 'Workset'), h('th', 'Visibility'))), tbody),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: () => app.commit('View worksets', () => doc.update(view.id, { worksets: state })) },
    ],
  });
}

export async function syncWithCommentDialog(app) {
  if (!app.sync.active) return app.requireShared();
  const comment = await promptDialog('Synchronize', 'Comment (optional): what did you change?', '', { okLabel: 'Synchronize', allowEmpty: true });
  if (comment === null || comment === undefined) return;
  return app.sync.sync({ comment });
}

export function syncHistoryDialog(app) {
  const log = syncLog(app.doc).reverse();
  const list = h('ul.file-list', { role: 'list' });
  for (const e of log) list.append(h('li', h('div.file-item', icon('history', 16), h('span.file-name', e.comment || 'Synchronized'), h('span.file-meta', `${e.by} · ${ago(e.at)}`))));
  return openDialog({
    title: 'Synchronization History',
    body: log.length ? list : h('p.dialog-text', 'Nobody has synchronized this project yet. Save a project to Puter and share it to work on it together.'),
    size: 'md',
    actions: [{ label: 'Close', primary: true, value: true }],
  });
}
