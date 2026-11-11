// Events panel: the event log (errors, warnings such as playback dropouts,
// and information messages) as a table. Click a column heading to sort by it
// (again to reverse); select rows to delete them, or clear the whole log.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { sortEvents, eventTypeLabel } from '../lib/event-log.js';

const COLUMNS = [
  ['type', 'Type'],
  ['time', 'Time'],
  ['name', 'Name'],
  ['event', 'Event'],
];

const TYPE_ICONS = { error: 'circle-alert', warning: 'triangle-alert', info: 'info' };

/** Clock time of an event; the date too when it was not today. */
export function eventTime(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

export function eventsPanel(app) {
  const log = app.eventLog;
  const selected = new Set();
  let sort = { key: 'time', dir: 'asc' };
  let anchor = null;

  const heads = COLUMNS.map(([key, label]) =>
    h('th', { scope: 'col', dataset: { key } }, h('button.sort-btn', { type: 'button', onclick: () => sortBy(key) }, label, h('span.sort-arrow', { 'aria-hidden': 'true' }))),
  );
  const body = h('tbody');
  const table = h('table.data-table.events-table', { role: 'grid', 'aria-label': 'Events', 'aria-multiselectable': 'true' }, h('thead', h('tr', heads)), body);
  const del = h('button.btn', { type: 'button', onclick: () => deleteSelected() }, icon('trash-2', 13), 'Delete');
  const clearAll = h('button.btn', { type: 'button', onclick: () => log.clear() }, 'Clear All');
  const el = h('div.events-panel', h('div.events-body', h('div.table-scroll', table), h('div.events-actions', del, clearAll)));

  function sortBy(key) {
    sort = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' };
    render();
  }

  function deleteSelected() {
    if (!selected.size) return;
    const rows = sorted();
    const last = rows.findLastIndex((e) => selected.has(e.id));
    const next = rows.slice(last + 1).find((e) => !selected.has(e.id)) || rows.slice(0, last).reverse().find((e) => !selected.has(e.id));
    log.remove([...selected]);
    selected.clear();
    if (next) selected.add(next.id);
    render();
    body.querySelector('tr[aria-selected="true"]')?.focus();
  }

  const sorted = () => sortEvents(log.entries, sort.key, sort.dir);

  const select = (id, e) => {
    const rows = sorted();
    if (e?.shiftKey && anchor != null) {
      const a = rows.findIndex((x) => x.id === anchor);
      const b = rows.findIndex((x) => x.id === id);
      if (!(e.metaKey || e.ctrlKey)) selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(rows[i].id);
    } else if (e?.metaKey || e?.ctrlKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      selected.clear();
      selected.add(id);
      anchor = id;
    }
    render();
    body.querySelector(`tr[data-id="${id}"]`)?.focus();
  };

  function render() {
    // New events arrive at any time and rebuild the rows: keyboard focus stays in the list.
    const focused = body.contains(document.activeElement) ? document.activeElement.closest('tr[data-id]')?.dataset.id : null;
    const rows = sorted();
    const ids = new Set(rows.map((e) => e.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    for (const th of heads) {
      const on = th.dataset.key === sort.key;
      th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.querySelector('.sort-arrow').textContent = on ? (sort.dir === 'asc' ? '↑' : '↓') : '';
    }
    body.replaceChildren();
    if (!rows.length) body.append(h('tr', h('td.empty-row', { colspan: '4' }, h('span.empty-text', 'No events. Errors and warnings appear here as they happen.'))));
    const now = Date.now();
    for (const e of rows) {
      const isSel = selected.has(e.id);
      body.append(
        h(
          `tr.event-${e.type}`,
          { tabindex: isSel ? '0' : '-1', 'aria-selected': String(isSel), dataset: { id: String(e.id) }, onclick: (ev) => select(e.id, ev) },
          h('td.name-cell.event-type', icon(TYPE_ICONS[e.type] || 'info', 13), eventTypeLabel(e.type)),
          h('td.tabular', { title: new Date(e.time).toLocaleString() }, eventTime(e.time, now)),
          h('td', { title: e.name }, e.name),
          h('td.event-message', { title: e.message }, e.message),
        ),
      );
    }
    if (!body.querySelector('tr[tabindex="0"]')) body.querySelector('tr[data-id]')?.setAttribute('tabindex', '0');
    if (focused) (body.querySelector(`tr[data-id="${CSS.escape(focused)}"]`) || body.querySelector('tr[tabindex="0"]'))?.focus({ preventScroll: true });
    del.disabled = !selected.size;
    clearAll.disabled = !rows.length;
  }

  body.addEventListener('keydown', (e) => {
    const rows = [...body.querySelectorAll('tr[data-id]')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (row) => row && select(Number(row.dataset.id), e.shiftKey ? { shiftKey: true } : null);
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') go(rows[i - 1]);
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      for (const r of rows) selected.add(Number(r.dataset.id));
      render();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  let visible = false;
  let stale = false;
  log.on('change', () => {
    // Off screen, just remember to redraw: errors can arrive in bursts.
    if (visible) render();
    else stale = true;
  });
  render();
  return {
    el,
    render,
    show() {
      visible = true;
      if (stale) render();
      stale = false;
    },
    hide() {
      visible = false;
    },
    deleteSelected,
  };
}
