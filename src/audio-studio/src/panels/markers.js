// Markers panel: the active file's cue and range markers. Click a marker to
// move the playhead there (range markers select their range); Shift-click
// extends the selection and Ctrl/Cmd-click toggles. Name, start, end,
// duration, type and description edit in place (double-click, or Enter/F2 on
// a row for the name); column headers sort; the filter menu limits the list
// to some marker types. Delete removes the selected markers. The toolbar also
// merges markers, exports range audio, adds markers to the playlist and sends
// range audio to Batch Process.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { MARKER_TYPES, sortMarkers } from '../model/markers.js';
import { parseTime, TIME_DISPLAY_KEYS } from '../lib/time.js';
import { playlistOf, setPlaylist } from './playlist.js';
import { addMarkers } from '../model/playlist.js';

const COLUMNS = [
  { id: 'name', label: 'Name', key: (m) => (m.name || '').toLowerCase() },
  { id: 'start', label: 'Start', key: (m) => m.start },
  { id: 'end', label: 'End', key: (m) => m.start + m.duration },
  { id: 'duration', label: 'Duration', key: (m) => m.duration },
  { id: 'type', label: 'Type', key: (m) => m.type },
  { id: 'description', label: 'Description', key: (m) => (m.description || '').toLowerCase() },
];

/** Markers matching a search text and type filter, sorted by a column. */
export function visibleMarkers(markers, { query = '', types = null, sort = { col: 'start', dir: 1 } } = {}) {
  const q = query.trim().toLowerCase();
  const col = COLUMNS.find((c) => c.id === sort.col) || COLUMNS[1];
  return markers
    .filter((m) => (!types || types.has(m.type)) && (!q || (m.name || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q)))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const x = col.key(a.m);
      const y = col.key(b.m);
      return (x < y ? -1 : x > y ? 1 : a.i - b.i) * sort.dir;
    })
    .map((x) => x.m);
}

/**
 * A marker after editing one field. Times are frames; the end and duration
 * keep the start fixed, the start keeps the duration. Cues have no end.
 */
export function editMarkerField(m, field, value, length) {
  const clamp = (f) => Math.max(0, Math.min(length, Math.round(f)));
  switch (field) {
    case 'start':
      return { ...m, start: clamp(Math.min(value, length - m.duration)) };
    case 'end':
      return { ...m, duration: Math.max(0, clamp(value) - m.start) };
    case 'duration':
      return { ...m, duration: Math.max(0, Math.min(Math.round(value), length - m.start)) };
    default:
      return { ...m, [field]: value };
  }
}

export function markersPanel(app) {
  const selected = new Set();
  let anchor = null;
  let sort = { col: 'start', dir: 1 };
  let types = null; // null: every type
  const search = h('input.input.panel-search', { type: 'search', placeholder: 'Search markers', 'aria-label': 'Search markers' });
  const ids = () => ({ ids: [...selected] });
  const tbtn = (cmd, ic, label) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: () => app.commands.run(cmd, ids()), dataset: { cmd } }, icon(ic, 15));
  const playlistBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Add to Playlist', title: 'Add Selected Markers to the Playlist', onclick: () => addToPlaylist() }, icon('list-plus', 15));
  const batchBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Send Ranges to Batch Process', title: 'Send the audio of the selected range markers (or of all of them) to Batch Process', onclick: () => sendToBatch() }, icon('layers', 15));
  const filterBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Filter by type', title: 'Show Marker Types', 'aria-haspopup': 'menu', onclick: () => filterMenu() }, icon('list-filter', 15));
  const toolbar = h(
    'div.panel-toolbar',
    tbtn('marker.add', 'marker-add', 'Add Cue Marker (M)'),
    tbtn('marker.deleteSelected', 'trash-2', 'Delete Selected Markers'),
    tbtn('marker.merge', 'link', 'Merge Selected Markers'),
    tbtn('file.exportRanges', 'file-audio', 'Export Audio within Range Markers'),
    playlistBtn,
    batchBtn,
    tbtn('file.exportMarkers', 'upload', 'Export Markers'),
    search,
    filterBtn,
  );
  const headRow = h('tr');
  const body = h('tbody');
  const table = h('table.data-table.markers-table', { role: 'grid', 'aria-label': 'Markers', 'aria-multiselectable': 'true' }, h('thead', headRow), body);
  const el = h('div.markers-panel', toolbar, h('div.table-scroll', table));
  app.selectedMarkerIds = () => [...selected];

  const doc = () => (app.active && app.active.state?.markers ? app.active : null);

  const renderHead = () => {
    headRow.replaceChildren(
      ...COLUMNS.map((c) =>
        h(
          'th',
          { scope: 'col', 'aria-sort': sort.col === c.id ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
          h('button.th-sort', { type: 'button', onclick: () => {
            sort = { col: c.id, dir: sort.col === c.id ? -sort.dir : 1 };
            render();
          } }, c.label, sort.col === c.id ? icon(sort.dir > 0 ? 'chevron-up' : 'chevron-down', 12) : null),
        ),
      ),
    );
  };

  const commit = (m, field, value) => {
    const d = doc();
    // Onto the marker as it is now: it may have been moved (on the ruler) while its cell was edited.
    const current = d?.state.markers.find((x) => x.id === m.id);
    if (!current) return;
    const next = editMarkerField(current, field, value, d.length);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    d.apply('Edit Marker', { ...d.state, markers: sortMarkers(d.state.markers.map((x) => (x.id === m.id ? next : x))) });
  };

  /** Turns a cell into a text field; Enter or blur commits, Escape cancels. */
  const editCell = (td, m, field) => {
    const d = doc();
    if (!d || td.querySelector('input, select')) return;
    const time = field === 'start' || field === 'end' || field === 'duration';
    if (time && field !== 'start' && !m.duration) return;
    const initial = time ? app.formatTime(field === 'start' ? m.start : field === 'end' ? m.start + m.duration : m.duration, d.sampleRate) : m[field] || '';
    const input = h('input.input.cell-edit', { type: 'text', value: initial, 'aria-label': `${COLUMNS.find((c) => c.id === field).label} of ${m.name || 'marker'}` });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value !== initial) {
        if (time) {
          const f = parseTime(input.value, d.sampleRate, app.prefs.get('timeFormat'), app.timeOptions?.() || {});
          if (Number.isFinite(f)) commit(m, field, f);
          else app.notify('Enter a time in the current time format.', { error: true });
        } else commit(m, field, input.value.trim());
      }
      // The row holds the text field: build it again even when the marker did not change.
      rowCache.delete(m);
      render();
      body.querySelector(`tr[data-id="${m.id}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    td.replaceChildren(input);
    input.focus();
    input.select();
  };

  /**
   * The editor's ruler shows the panel's selection. The editor keeps one set and reports it
   * back (marker-selection), so it gets the whole set: adding only the clicked marker made
   * a Shift-click range select just its two ends and a Ctrl/Cmd-click never deselect.
   */
  const showOnRuler = () => {
    const view = app.currentView?.();
    if (!view?.selectMarker) return;
    view.selectedMarkers = new Set(selected);
    view.selectMarker(null, { add: true });
  };

  /** Marks the selected rows in place: rebuilding thousands of rows is slow. */
  const markRows = () => {
    const rows = [...body.querySelectorAll('tr[data-id]')];
    for (const row of rows) {
      const on = selected.has(row.dataset.id);
      row.setAttribute('aria-selected', String(on));
      row.tabIndex = on ? 0 : -1;
    }
    if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
    updateButtons();
  };

  const select = (m, e, visible) => {
    const d = doc();
    const before = [...selected].join();
    if (e.shiftKey && anchor) {
      const a = visible.findIndex((x) => x.id === anchor);
      const b = visible.findIndex((x) => x.id === m.id);
      if (a >= 0 && b >= 0) {
        selected.clear();
        for (const x of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(x.id);
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (selected.has(m.id)) selected.delete(m.id);
      else selected.add(m.id);
      anchor = m.id;
    } else {
      selected.clear();
      selected.add(m.id);
      anchor = m.id;
      if (m.duration) d.setSelection(m.start, m.start + m.duration);
      else d.setSelection(m.start, m.start);
      // Through the editor, so playback in progress jumps there too.
      const view = app.currentView?.();
      if (view?.seek && view.doc === d) view.seek(m.start);
      else d.setCursor(m.start);
      const v = d.view;
      if (m.start < v.start || m.start > v.end) {
        const span = v.end - v.start;
        d.setView(m.start - span / 3, m.start - span / 3 + span);
      }
    }
    showOnRuler();
    // Rows are marked in place (not rebuilt), so the second click of a double-click lands
    // on the same row and the double-click reaches it.
    if ([...selected].join() !== before) markRows();
    body.querySelector(`tr[data-id="${m.id}"]`)?.focus();
  };

  /** The markers listed now, in order (row handlers read it: rows outlive a render). */
  let visible = [];
  /** marker object -> its row, for the time format and sample rate in rowKey. */
  let rowCache = new WeakMap();
  let rowKey = '';

  const buildRow = (m, d) => {
    const cell = (field, content, cls = '') => h(`td${cls}`, { dataset: { field } }, content);
    const typeSel = h(
      'select.select.cell-select',
      { 'aria-label': `Type of ${m.name || 'marker'}`, onclick: (e) => e.stopPropagation(), onchange: (e) => commit(m, 'type', e.target.value) },
      MARKER_TYPES.map((t) => h('option', { value: t.id, selected: t.id === m.type }, t.label)),
    );
    const row = h(
      'tr',
      {
        tabindex: '-1',
        dataset: { id: m.id },
        onclick: (e) => select(m, e, visible),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!selected.has(m.id)) select(m, {}, visible);
          rowMenu(e.clientX, e.clientY);
        },
        onkeydown: (e) => {
          if (e.target !== row) return;
          const rows = [...body.querySelectorAll('tr[data-id]')];
          const i = rows.indexOf(row);
          const go = (j) => rows[j] && select(visible[j], { shiftKey: e.shiftKey }, visible);
          if (e.key === 'ArrowDown') go(i + 1);
          else if (e.key === 'ArrowUp') go(i - 1);
          else if (e.key === 'Enter' || e.key === 'F2') editCell(row.firstChild, m, 'name');
          else if (e.key === 'Delete' || e.key === 'Backspace') app.commands.run('marker.deleteSelected', ids());
          else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
            for (const x of visible) selected.add(x.id);
            showOnRuler();
            markRows();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        },
      },
      cell('name', [icon(m.duration ? 'bookmark' : 'flag', 13), h('span.marker-name', m.name || 'Untitled')], '.name-cell'),
      cell('start', app.formatTime(m.start, d.sampleRate), '.tabular.hot-cell'),
      cell('end', m.duration ? app.formatTime(m.start + m.duration, d.sampleRate) : '', '.tabular.hot-cell'),
      cell('duration', m.duration ? app.formatTime(m.duration, d.sampleRate) : '', '.tabular.hot-cell'),
      h('td', typeSel),
      cell('description', m.description || '', '.muted'),
    );
    return row;
  };

  /** What the rows were last built from: edits that leave the markers alone keep them. */
  let shown = null;

  const render = () => {
    // A focused row that goes away (deleted, filtered) hands focus to the row now in its
    // place, so keys such as Delete stay in the list instead of reaching the editor.
    const focusedRow = body.contains(document.activeElement) ? document.activeElement.closest('tr[data-id]') : null;
    const focusedAt = focusedRow ? [...body.querySelectorAll('tr[data-id]')].indexOf(focusedRow) : -1;
    renderHead();
    const d = doc();
    shown = d ? { doc: d, markers: d.state.markers, rate: d.sampleRate } : null;
    filterBtn.classList.toggle('on', Boolean(types));
    if (!d) {
      body.replaceChildren();
      body.append(h('tr', h('td.empty-row', { colspan: '6' }, h('span.empty-text', 'No file open'))));
      updateButtons();
      return;
    }
    for (const id of [...selected]) if (!d.state.markers.some((m) => m.id === id)) selected.delete(id);
    const markers = visibleMarkers(d.state.markers, { query: search.value, types, sort });
    if (!markers.length) body.replaceChildren(h('tr', h('td.empty-row', { colspan: '6' }, h('span.empty-text', search.value.trim() || types ? 'No matching markers' : 'No markers. Press M to add one at the playhead.'))));
    visible = markers;
    // Rows are kept per marker object (markers are replaced, never changed in place), so a
    // change to a few markers in a long list builds only their rows.
    const options = JSON.stringify(app.timeOptions?.() || {});
    const key = `${d.sampleRate}|${app.prefs.get('timeFormat')}|${options}`;
    if (key !== rowKey) {
      rowCache = new WeakMap();
      rowKey = key;
    }
    // Kept rows stay in place (moving thousands of rows is slow too); new ones go in between.
    let at = markers.length ? body.firstChild : null;
    for (const m of markers) {
      let row = rowCache.get(m);
      if (!row) {
        row = buildRow(m, d);
        rowCache.set(m, row);
      }
      const isSel = String(selected.has(m.id));
      if (row.getAttribute('aria-selected') !== isSel) row.setAttribute('aria-selected', isSel);
      row.tabIndex = isSel === 'true' ? 0 : -1;
      if (row === at) at = at.nextSibling;
      else body.insertBefore(row, at);
    }
    while (at) {
      const next = at.nextSibling;
      at.remove();
      at = next;
    }
    if (!body.querySelector('tr[tabindex="0"]')) {
      const first = body.querySelector('tr[data-id]');
      if (first) first.tabIndex = 0;
    }
    if (focusedRow) {
      const rows = [...body.querySelectorAll('tr[data-id]')];
      const same = rows.find((r) => r.dataset.id === focusedRow.dataset.id);
      (same || rows[Math.min(focusedAt, rows.length - 1)])?.focus({ preventScroll: Boolean(same) });
    }
    updateButtons();
  };

  const updateButtons = () => {
    for (const b of toolbar.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd, ids());
    playlistBtn.disabled = !doc() || !selected.size || !app.panels.has('playlist');
    batchBtn.disabled = !app.panels.has('batch') || !batchRanges().length;
  };

  const addToPlaylist = () => {
    const d = doc();
    if (!d || !selected.size) return;
    const order = d.state.markers.filter((m) => selected.has(m.id)).map((m) => m.id);
    setPlaylist(d, addMarkers(playlistOf(d), order));
    app.emit('playlist', d);
    app.dock?.openPanel('playlist', { focus: false });
    app.setStatus(`Added ${order.length} marker${order.length === 1 ? '' : 's'} to the playlist`);
  };

  /** Range markers to batch: the selected ones, or every range marker when none is selected. */
  const batchRanges = () => {
    const d = doc();
    if (!d || d.kind !== 'audio') return [];
    const ranges = d.state.markers.filter((m) => m.duration > 0);
    const picked = ranges.filter((m) => selected.has(m.id));
    return selected.size ? picked : ranges;
  };
  const sendToBatch = () => {
    const d = doc();
    const ranges = batchRanges();
    if (!d || !ranges.length || !app.panels.has('batch')) return;
    const stem = d.name.replace(/\.[a-z0-9]{1,5}$/i, '');
    const sources = ranges.map((m, i) => ({ type: 'range', doc: d, start: m.start, end: m.start + m.duration, name: `${stem} ${m.name || `Range ${i + 1}`}` }));
    app.dock?.openPanel('batch');
    app.dock?.instances.get('batch')?.api?.add(sources);
  };

  const filterMenu = () => {
    const r = filterBtn.getBoundingClientRect();
    const on = (id) => !types || types.has(id);
    app.openMenu(
      [
        ...MARKER_TYPES.map((t) => ({
          type: 'cmd',
          label: t.label,
          enabled: true,
          checked: on(t.id),
          run: () => {
            const next = new Set(types || MARKER_TYPES.map((x) => x.id));
            if (next.has(t.id)) next.delete(t.id);
            else next.add(t.id);
            types = next.size === MARKER_TYPES.length ? null : next;
            render();
          },
        })),
        { type: 'sep' },
        { type: 'cmd', label: 'Show All Types', enabled: Boolean(types), run: () => ((types = null), render()) },
      ],
      { x: r.left, y: r.bottom + 2, anchor: filterBtn, label: 'Marker types' },
    );
  };

  const rowMenu = (x, y) => {
    const item = (cmd, label) => ({ type: 'cmd', label: label || app.commands.label(cmd), enabled: app.commands.isEnabled(cmd, ids()), run: () => app.commands.run(cmd, ids()) });
    app.openMenu(
      [
        item('marker.rename', 'Edit Marker...'),
        item('marker.merge'),
        item('marker.convertRange'),
        { type: 'sep' },
        { type: 'cmd', label: 'Add to Playlist', enabled: !playlistBtn.disabled, run: addToPlaylist },
        { type: 'cmd', label: 'Send Ranges to Batch Process', enabled: !batchBtn.disabled, run: sendToBatch },
        item('file.exportRanges'),
        { type: 'sep' },
        item('marker.deleteSelected'),
      ],
      { x, y, label: 'Marker' },
    );
  };

  // Delegated: the first click of a double-click re-renders the rows.
  body.addEventListener('dblclick', (e) => {
    const td = (document.elementFromPoint(e.clientX, e.clientY) || e.target).closest?.('td[data-field]');
    const m = td && doc()?.state.markers.find((x) => x.id === td.parentElement.dataset.id);
    if (m) editCell(td, m, td.dataset.field);
  });
  search.addEventListener('input', render);
  app.on('active', () => {
    selected.clear();
    anchor = null;
    render();
  });
  app.on('doc-change', (d, e) => {
    if (d !== app.active || (e.kind !== 'edit' && e.kind !== 'history')) return;
    // Rebuilding every row is slow with thousands of markers; most edits do not touch them.
    if (shown && shown.doc === d && shown.markers === d.state.markers && shown.rate === d.sampleRate) updateButtons();
    else render();
  });
  app.on('marker-selection', (d, list) => {
    const next = [...list];
    if (next.length === selected.size && next.every((id) => selected.has(id))) return;
    selected.clear();
    for (const id of next) selected.add(id);
    markRows();
  });
  app.on('prefs', (key) => TIME_DISPLAY_KEYS.has(key) && render());
  render();
  return { el, show: render };
}
