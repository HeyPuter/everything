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
import { t } from '../i18n/index.js';
import { refreshQuery, deleteQuery, saveQuery, loadedTable, queryNameProblem, uniqueQueryName, sourceSummary, queryById } from '../core/queries.js';
import { queryIo, openImportData, fitQueryTables } from './get-data.js';

const newId = () => (globalThis.crypto?.randomUUID?.() || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** ctx.edit(queryId) opens the Power Query Editor on a query. */
export function createQueriesPane(ctx) {
  const busy = new Set();
  const errors = new Map();
  let lastVersion = -1;
  const list = el('div.qc-list', { role: 'list', 'aria-label': t('queriesPane.queries') });
  // Beside the list rather than in it: a list holds list items alone.
  const empty = el('p.qc-empty', { hidden: true }, t('queriesPane.empty'));
  const count = el('span.qc-count');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': t('queriesPane.close'), html: icon('x', 16), onclick: () => api.hide() });
  const root = el('section.a11y-pane.qc-pane', { role: 'region', 'aria-label': t('queriesPane.title'), hidden: true },
    el('div.a11y-head', {}, el('span.a11y-title', {}, t('queriesPane.title')), close),
    el('div.qc-tabs', { role: 'tablist' }, el('span.qc-tab', { role: 'tab', 'aria-selected': 'true' }, t('queriesPane.queries')), count),
    el('div.a11y-body', {}, list, empty));

  const status = (q) => {
    if (busy.has(q.id)) return t('queriesPane.refreshing');
    if (errors.has(q.id)) return t('queriesPane.loadError', { error: errors.get(q.id) });
    if (q.load?.kind !== 'table') return t('queriesPane.connectionOnly');
    if (!loadedTable(ctx.wb, q)) return t('queriesPane.tableRemoved');
    const n = q.rowCount ?? 0;
    return q.errorCount ? t('queriesPane.loadedWithErrors', { rows: n, errors: q.errorCount }) : t('queriesPane.loaded', { rows: n });
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
    const ok = await confirmDialog({ title: t('queriesPane.deleteTitle'), message: hit ? t('queriesPane.deleteLoaded', { name: q.name }) : t('queriesPane.deleteConfirm', { name: q.name }), confirmLabel: t('common.delete') });
    if (!ok) return;
    deleteQuery(ctx.wb, q.id);
    errors.delete(q.id);
    toast(t('queriesPane.deleted', { name: q.name }), { icon: 'trash' });
  }

  async function rename(q) {
    const name = await promptDialog({ title: t('common.rename'), label: t('common.name'), value: q.name, confirmLabel: t('common.ok'), validate: (v) => queryNameProblem(ctx.wb, v, q.id) });
    if (!name || name.trim() === q.name) return;
    saveQuery(ctx.wb, { ...q, name: name.trim() });
  }

  const menu = (q, at) => openMenu({ ...at, label: q.name, items: [
    { label: t('common.edit'), icon: 'pencil', onSelect: () => ctx.edit(q.id) },
    { label: t('common.delete'), icon: 'trash', onSelect: () => remove(q) },
    { label: t('common.rename'), onSelect: () => rename(q) },
    { label: t('common.refresh'), icon: 'refresh', onSelect: () => refresh(q) },
    { label: t('queriesPane.loadTo'), onSelect: () => openImportData(ctx, { query: q }) },
    { separator: true },
    { label: t('queriesPane.duplicate'), icon: 'duplicate', onSelect: () => saveQuery(ctx.wb, { ...JSON.parse(JSON.stringify(q)), id: newId(), name: uniqueQueryName(ctx.wb, q.name), load: { kind: 'connection' } }) },
    { label: t('queriesPane.reference'), onSelect: () => saveQuery(ctx.wb, { id: newId(), name: uniqueQueryName(ctx.wb, q.name), source: { kind: 'query', query: q.name }, steps: [], load: { kind: 'connection' } }) },
  ] });

  function render(force = false) {
    if (root.hidden) return;
    if (!force && ctx.wb.version === lastVersion) return;
    lastVersion = ctx.wb.version;
    const queries = ctx.wb.queries || [];
    count.textContent = String(queries.length);
    list.hidden = !queries.length;
    empty.hidden = !!queries.length;
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
        el('button.icon-btn', { type: 'button', title: t('common.refresh'), 'aria-label': t('queriesPane.refreshNamed', { name: q.name }), html: icon(busy.has(q.id) ? 'spinner' : 'refresh', 14), onclick: () => refresh(q) }),
        el('button.icon-btn', { type: 'button', title: t('common.edit'), 'aria-label': t('queriesPane.editNamed', { name: q.name }), html: icon('pencil', 14), onclick: () => ctx.edit(q.id) }),
        el('button.icon-btn', { type: 'button', title: t('common.delete'), 'aria-label': t('queriesPane.deleteNamed', { name: q.name }), html: icon('trash', 14), onclick: () => remove(q) }),
        el('button.icon-btn', { type: 'button', title: t('queriesPane.more'), 'aria-label': t('queriesPane.moreNamed', { name: q.name }), html: icon('more', 14), onclick: (e) => menu(q, { anchor: e.currentTarget }) })));
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
