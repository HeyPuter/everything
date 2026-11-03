/**
 * Data ▸ Queries & Connections: the pane along the right of the window listing the workbook's queries, each
 * with what it last loaded ("12 rows loaded.", "Connection only."), and Refresh, Edit and Delete beside it.
 * A right-click offers the rest: Load To…, Duplicate, Reference, Rename. The list follows the workbook.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { confirmDialog, promptDialog } from './modal.js';
import { toast } from './toast.js';
import { refreshQuery, deleteQuery, saveQuery, loadedTable, queryNameProblem, uniqueQueryName, sourceSummary, queryById } from '../core/queries.js';
import { queryIo, openImportData, fitQueryTables } from './get-data.js';

const newId = () => (globalThis.crypto?.randomUUID?.() || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** ctx.edit(queryId) opens the Power Query Editor on a query. */
export function createQueriesPane(ctx) {
  const busy = new Set();
  const errors = new Map();
  let lastVersion = -1;
  const list = el('div.qc-list', { role: 'list', 'aria-label': 'Queries' });
  const count = el('span.qc-count');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Queries & Connections', html: icon('x', 16), onclick: () => api.hide() });
  const root = el('section.a11y-pane.qc-pane', { role: 'region', 'aria-label': 'Queries & Connections', hidden: true },
    el('div.a11y-head', {}, el('span.a11y-title', {}, 'Queries & Connections'), close),
    el('div.qc-tabs', { role: 'tablist' }, el('span.qc-tab', { role: 'tab', 'aria-selected': 'true' }, 'Queries'), count),
    el('div.a11y-body', {}, list));

  const status = (q) => {
    if (busy.has(q.id)) return 'Refreshing…';
    if (errors.has(q.id)) return `Load error: ${errors.get(q.id)}`;
    if (q.load?.kind !== 'table') return 'Connection only.';
    if (!loadedTable(ctx.wb, q)) return 'Not loaded: its table was removed.';
    const n = q.rowCount ?? 0;
    return `${n.toLocaleString()} row${n === 1 ? '' : 's'} loaded.${q.errorCount ? ` ${q.errorCount} error${q.errorCount === 1 ? '' : 's'}.` : ''}`;
  };

  async function refresh(q) {
    if (busy.has(q.id)) return;
    if (ctx.allowQuerySources && !await ctx.allowQuerySources([q])) return;
    busy.add(q.id); render(true);
    const res = await refreshQuery(ctx.wb, queryById(ctx.wb, q.id) || q, queryIo(ctx));
    busy.delete(q.id);
    if (res.error) errors.set(q.id, res.error); else { errors.delete(q.id); fitQueryTables(ctx, [queryById(ctx.wb, q.id)]); }
    render(true);
  }

  async function remove(q) {
    const hit = loadedTable(ctx.wb, q);
    const ok = await confirmDialog({ title: 'Delete Query', message: `Are you sure you want to delete "${q.name}"?${hit ? ' Its loaded table stays in the workbook as data.' : ''}`, confirmLabel: 'Delete' });
    if (!ok) return;
    deleteQuery(ctx.wb, q.id);
    errors.delete(q.id);
    toast(`Query ${q.name} deleted`, { icon: 'trash' });
  }

  async function rename(q) {
    const name = await promptDialog({ title: 'Rename', label: 'Name', value: q.name, confirmLabel: 'OK', validate: (v) => queryNameProblem(ctx.wb, v, q.id) });
    if (!name || name.trim() === q.name) return;
    saveQuery(ctx.wb, { ...q, name: name.trim() });
  }

  const menu = (q, at) => openMenu({ ...at, label: q.name, items: [
    { label: 'Edit', icon: 'pencil', onSelect: () => ctx.edit(q.id) },
    { label: 'Delete', icon: 'trash', onSelect: () => remove(q) },
    { label: 'Rename', onSelect: () => rename(q) },
    { label: 'Refresh', icon: 'refresh', onSelect: () => refresh(q) },
    { label: 'Load To…', onSelect: () => openImportData(ctx, { query: q }) },
    { separator: true },
    { label: 'Duplicate', icon: 'duplicate', onSelect: () => saveQuery(ctx.wb, { ...JSON.parse(JSON.stringify(q)), id: newId(), name: uniqueQueryName(ctx.wb, q.name), load: { kind: 'connection' } }) },
    { label: 'Reference', onSelect: () => saveQuery(ctx.wb, { id: newId(), name: uniqueQueryName(ctx.wb, q.name), source: { kind: 'query', query: q.name }, steps: [], load: { kind: 'connection' } }) },
  ] });

  function render(force = false) {
    if (root.hidden) return;
    if (!force && ctx.wb.version === lastVersion) return;
    lastVersion = ctx.wb.version;
    const queries = ctx.wb.queries || [];
    count.textContent = String(queries.length);
    if (!queries.length) {
      list.replaceChildren(el('p.qc-empty', {}, 'This workbook has no queries. Use Data ▸ Get Data to bring data in.'));
      return;
    }
    list.replaceChildren(...queries.map((q) => {
      const item = el('div.qc-item', { role: 'listitem', title: sourceSummary(q), tabindex: 0,
        ondblclick: () => ctx.edit(q.id),
        oncontextmenu: (e) => { e.preventDefault(); menu(q, { x: e.clientX, y: e.clientY }); },
        onkeydown: (e) => {
          // The row's own keys; Enter or Delete on one of its buttons is that button's.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') ctx.edit(q.id);
          if (e.key === 'Delete') remove(q);
        } },
      el('span.qc-icon', { html: icon('table', 18) }),
      el('div.qc-text', {}, el('div.qc-name', {}, q.name), el('div.qc-status', {}, status(q))),
      el('div.qc-actions', {},
        el('button.icon-btn', { type: 'button', title: 'Refresh', 'aria-label': `Refresh ${q.name}`, html: icon(busy.has(q.id) ? 'spinner' : 'refresh', 14), onclick: () => refresh(q) }),
        el('button.icon-btn', { type: 'button', title: 'Edit', 'aria-label': `Edit ${q.name}`, html: icon('pencil', 14), onclick: () => ctx.edit(q.id) }),
        el('button.icon-btn', { type: 'button', title: 'Delete', 'aria-label': `Delete ${q.name}`, html: icon('trash', 14), onclick: () => remove(q) }),
        el('button.icon-btn', { type: 'button', title: 'More', 'aria-label': `More for ${q.name}`, html: icon('more', 14), onclick: (e) => menu(q, { anchor: e.currentTarget }) })));
      if (errors.has(q.id)) item.classList.add('qc-failed');
      return item;
    }));
  }

  const unsubscribe = ctx.subscribe(() => render());
  const onChange = () => render();
  ctx.wb.addEventListener?.('change', onChange);
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show() { root.hidden = false; render(true); },
    hide() { root.hidden = true; ctx.grid?.focus?.(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    /** Record what a refresh done elsewhere (Refresh All) answered. */
    noteResults(failed = []) { errors.clear(); for (const f of failed) { const q = (ctx.wb.queries || []).find((x) => x.name === f.name); if (q) errors.set(q.id, f.error); } render(true); },
    render,
    destroy() { unsubscribe(); ctx.wb.removeEventListener?.('change', onChange); root.remove(); },
  };
  return api;
}
