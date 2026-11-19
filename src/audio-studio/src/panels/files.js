// Files panel: every open audio file and session with its format details.
// Click picks a file (it becomes the active one); Shift-click and
// Ctrl/Cmd-click select several, for closing, inserting into a session, batch
// processing or dragging together. Double-click or Enter opens one in the
// editor; Delete closes the selected files; rows can be dragged into a
// multitrack session (dataTransfer type application/x-audio-studio-file: file
// ids, one per line). Right-click a row (or press Shift+F10) for the file
// commands. The app event 'reveal-files' (file ids) highlights the files behind clips.
// The disclosure arrow lists a file's markers (click one to go there); the
// footer plays the selected file from its start, loops, and can auto-play
// files as they are picked. Column headers sort; the panel menu shows or hides
// columns and the preview footer.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { resolveItems } from '../ui/menubar.js';

const bitsOf = (doc) => (doc.kind === 'audio' ? doc.info.bitDepth ?? 0 : 32);
const channelsOf = (doc) => (doc.kind === 'audio' ? doc.channelCount : 2);

/** What kind of media a document is, for the Media Type column. */
export function mediaTypeOf(doc) {
  if (doc.kind === 'session') return 'Multitrack Session';
  if (doc.kind !== 'audio') return '';
  return doc.video || doc.state?.video ? 'Audio with Video' : 'Audio';
}

/** Where a document lives: its Puter folder, this device, or not saved yet. */
export function locationOf(doc) {
  const src = doc.source || {};
  if (src.type === 'puter' && src.path) {
    const i = src.path.lastIndexOf('/');
    return i > 0 ? src.path.slice(0, i) : '/';
  }
  if (src.type === 'local') return 'This device';
  return 'Not saved';
}

export const FILE_COLUMNS = [
  { id: 'name', label: 'Name', key: (d) => d.name.toLowerCase() },
  { id: 'status', label: 'Status', key: (d) => (d.dirty ? 1 : 0) },
  { id: 'duration', label: 'Duration', key: (d) => d.length / d.sampleRate },
  { id: 'rate', label: 'Sample Rate', key: (d) => d.sampleRate },
  { id: 'channels', label: 'Channels', key: channelsOf },
  { id: 'bits', label: 'Bit Depth', key: bitsOf },
  { id: 'format', label: 'Format', key: (d) => (d.kind === 'audio' ? (d.info.format || '').toLowerCase() : '~session') },
  // Optional columns: off until turned on in the panel menu.
  { id: 'media', label: 'Media Type', key: mediaTypeOf, optional: true },
  { id: 'markers', label: 'Markers', key: (d) => d.state?.markers?.length || 0, optional: true },
  { id: 'location', label: 'Location', key: (d) => locationOf(d).toLowerCase(), optional: true },
];

/** Documents matching a search text, sorted by a column (stable; open order breaks ties). */
export function visibleFiles(docs, { query = '', sort = { col: 'name', dir: 1 } } = {}) {
  const q = query.trim().toLowerCase();
  const col = FILE_COLUMNS.find((c) => c.id === sort.col);
  const list = docs.filter((d) => !q || d.name.toLowerCase().includes(q)).map((d, i) => ({ d, i }));
  if (col) {
    list.sort((a, b) => {
      const x = col.key(a.d);
      const y = col.key(b.d);
      return (x < y ? -1 : x > y ? 1 : a.i - b.i) * sort.dir;
    });
  }
  return list.map((x) => x.d);
}

/**
 * The ids a click selects: a plain click picks one, Ctrl/Cmd toggles one,
 * Shift takes the run from the anchor in the listed order. Pure.
 */
export function clickSelection(selected, ids, id, anchor, { shift = false, toggle = false } = {}) {
  if (shift && anchor && ids.includes(anchor) && ids.includes(id)) {
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    return new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  }
  if (toggle) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  return new Set([id]);
}

export function filesPanel(app) {
  const search = h('input.input.panel-search', { type: 'search', placeholder: 'Search files', 'aria-label': 'Search files' });
  const tbtn = (cmd, ic, label, run) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: run || (() => app.commands.run(cmd)), dataset: { cmd } }, icon(ic, 15));
  const toolbar = h(
    'div.panel-toolbar',
    tbtn('file.open', 'folder-open', 'Open'),
    tbtn('file.import', 'download', 'Import'),
    tbtn('file.newAudio', 'file-plus', 'New Audio File'),
    tbtn('mt.insertFiles', 'mode-multitrack', 'Insert into Multitrack', () => insertSelected()),
    tbtn('file.close', 'trash-2', 'Close Selected Files', () => closeSelected()),
    search,
  );
  const head = h('tr');
  // Open order until a header is clicked.
  let sort = app.prefs.get('filesSort') || null;
  const hiddenCols = () => new Set(app.prefs.get('filesHiddenColumns') || []);
  const extraCols = () => new Set(app.prefs.get('filesExtraColumns') || []);
  const columnShown = (c) => c.id === 'name' || (c.optional ? extraCols().has(c.id) : !hiddenCols().has(c.id));
  const columns = () => FILE_COLUMNS.filter(columnShown);
  // Selected file ids; a plain click (or opening a file) selects just the active one.
  let selected = new Set(app.active ? [app.active.id] : []);
  let anchor = app.active?.id || null;
  /** The listed documents, in order, as last rendered. */
  let listed = [];
  const selectedDocs = () => {
    const docs = listed.filter((d) => selected.has(d.id));
    return docs.length ? docs : app.active ? [app.active] : [];
  };
  const renderHead = () => {
    head.replaceChildren(
      ...columns().map((c) => {
        const on = sort?.col === c.id;
        return h(
          'th',
          { scope: 'col', 'aria-sort': on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
          h('button.th-sort', { type: 'button', onclick: () => {
            sort = { col: c.id, dir: on ? -sort.dir : 1 };
            app.prefs.set('filesSort', sort);
            render();
          } }, c.label, on ? icon(sort.dir > 0 ? 'chevron-up' : 'chevron-down', 12) : null),
        );
      }),
    );
  };
  const body = h('tbody');
  const table = h('table.data-table', { role: 'grid', 'aria-label': 'Open files', 'aria-multiselectable': 'true' }, h('thead', head), body);
  const playBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Play from Start', title: 'Play from Start' }, icon('play', 15));
  const loopBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Loop Playback', title: 'Loop Playback', dataset: { cmd: 'transport.loop' }, onclick: () => app.commands.run('transport.loop') }, icon('repeat', 15));
  const autoPlay = h('input', { type: 'checkbox', checked: Boolean(app.prefs.get('filesAutoPlay')), onchange: (e) => app.prefs.set('filesAutoPlay', e.target.checked) });
  playBtn.addEventListener('click', () => {
    if (!app.active) return;
    if (app.engine.playing) app.stop();
    else app.play({ from: 0 });
  });
  const footer = h('div.panel-footer.files-footer', { hidden: app.prefs.get('filesPreviewBar') === false }, playBtn, loopBtn, h('label.check', { title: 'Play files as you select them' }, autoPlay, 'Auto-play'));
  const scroller = h('div.table-scroll', table);
  const el = h('div.files-panel', toolbar, scroller, footer);
  const expanded = new Set();
  const pick = (doc) => {
    const changed = app.active !== doc;
    app.activate(doc);
    if (changed && autoPlay.checked) app.play({ from: 0 });
  };
  const open = (doc) => {
    app.activate(doc);
    app.dock?.openPanel('editor');
  };

  // ------------------------------------------------------------ actions

  /** Closes the selected files one at a time; a cancelled save prompt stops there. */
  async function closeSelected(docs = selectedDocs()) {
    for (const doc of docs) {
      if (!app.documents.includes(doc)) continue;
      if (!(await app.closeDocument(doc))) break;
    }
  }

  async function insertSelected(docs = selectedDocs()) {
    const audio = docs.filter((d) => d.kind === 'audio' && d.length > 0);
    if (audio.length) return app.commands.run('mt.insertFiles', { docs: audio });
    // A session (or nothing) selected: the command's own behaviour (pick files to insert).
    return app.commands.run('mt.insertFiles');
  }

  /** Inserts into a chosen open session, or a new one ('new') made with the New Session dialog. */
  async function insertInto(target, docs = selectedDocs()) {
    const audio = docs.filter((d) => d.kind === 'audio' && d.length > 0);
    if (!audio.length) return;
    if (target === 'new') {
      const before = new Set(app.documents);
      await app.commands.run('file.newSession');
      target = app.documents.find((d) => d.kind === 'session' && !before.has(d));
      if (!target) return;
    }
    if (!app.documents.includes(target)) return;
    app.activate(target);
    return app.commands.run('mt.insertFiles', { docs: audio });
  }

  function sendToBatch(docs = selectedDocs()) {
    const audio = docs.filter((d) => d.kind === 'audio');
    if (!audio.length || !app.panels.has('batch')) return;
    app.dock?.openPanel('batch');
    app.dock?.instances.get('batch')?.api?.add(audio.map((doc) => ({ type: 'doc', doc })));
  }

  /** Runs a command that works on the active file after making `doc` the active one. */
  const onDoc = (doc, cmd) => {
    app.activate(doc);
    return app.commands.run(cmd);
  };

  function rowMenu(x, y) {
    const docs = selectedDocs();
    const one = docs.length === 1 ? docs[0] : null;
    const audio = docs.filter((d) => d.kind === 'audio');
    const insertable = audio.filter((d) => d.length > 0);
    const n = docs.length;
    const items = [
      { type: 'cmd', label: 'Open in Editor', enabled: Boolean(one), run: () => open(one) },
      { type: 'cmd', label: insertable.length > 1 ? `Insert ${insertable.length} Files into Multitrack Session` : 'Insert into Multitrack Session', enabled: insertable.length > 0, run: () => insertSelected(docs) },
    ];
    // With sessions open, choose which one (or a new one).
    const sessions = app.documents.filter((d) => d.kind === 'session');
    if (sessions.length && app.commands.commands.has('file.newSession')) {
      items.push({
        type: 'sub',
        label: 'Insert into',
        enabled: insertable.length > 0,
        items: [
          ...sessions.map((sd) => ({ type: 'cmd', label: sd.name, enabled: insertable.length > 0, run: () => insertInto(sd, docs) })),
          { type: 'sep' },
          { type: 'cmd', label: 'New Multitrack Session...', enabled: insertable.length > 0, run: () => insertInto('new', docs) },
        ],
      });
    }
    if (app.panels.has('batch')) items.push({ type: 'cmd', label: 'Send to Batch Process', enabled: audio.length > 0, run: () => sendToBatch(docs) });
    items.push(
      { type: 'sep' },
      { type: 'cmd', label: 'Save', enabled: Boolean(one), run: () => onDoc(one, 'file.save') },
      { type: 'cmd', label: 'Save As...', enabled: Boolean(one), run: () => onDoc(one, 'file.saveAs') },
    );
    if (app.commands.commands.has('file.revealInMedia')) {
      items.push({ type: 'cmd', label: 'Reveal in Media Browser', enabled: Boolean(one && one.source?.type === 'puter' && one.source.path && app.panels.has('media')), run: () => onDoc(one, 'file.revealInMedia') });
    }
    if (one?.state?.markers?.length) {
      items.push({ type: 'cmd', label: expanded.has(one.id) ? 'Hide Markers' : 'Show Markers', enabled: true, run: () => toggle(one) });
    }
    items.push(
      { type: 'sep' },
      { type: 'cmd', label: n > 1 ? `Close ${n} Files` : 'Close', enabled: n > 0, run: () => closeSelected(docs) },
      { type: 'cmd', label: 'Close Others', enabled: app.documents.length > n && n > 0, run: () => closeSelected(app.documents.filter((d) => !docs.includes(d))) },
      { type: 'cmd', label: 'Close All', enabled: app.documents.length > 0, run: () => closeSelected([...app.documents]) },
      { type: 'sep' },
      { type: 'cmd', label: 'Select All', enabled: listed.length > 1, run: () => selectAll() },
    );
    app.openMenu(items, { x, y, label: 'File' });
  }

  function selectAll() {
    selected = new Set(listed.map((d) => d.id));
    markRows();
  }

  /** Marks selected and active rows in place (a click must not rebuild the row it lands on). */
  function markRows() {
    for (const row of body.querySelectorAll('tr[data-id]')) {
      row.setAttribute('aria-selected', String(selected.has(row.dataset.id)));
      row.classList.toggle('is-active', row.dataset.id === app.active?.id);
    }
  }

  /** Click and keyboard selection on a row; `opts` are the modifier keys. */
  function selectRow(doc, { shift = false, toggle: tog = false } = {}) {
    const ids = listed.map((d) => d.id);
    selected = clickSelection(selected, ids, doc.id, anchor, { shift, toggle: tog });
    if (!shift) anchor = doc.id;
    if (!shift && !tog) pick(doc);
    markRows();
  }

  // Files picked out by Clip > Reveal Clips in Files Panel, until another file is opened.
  let revealed = new Set();
  const render = () => {
    // Rows are rebuilt (playback starting, edits): keyboard focus stays on the same file.
    const inBody = body.contains(document.activeElement);
    const focusedRow = inBody ? document.activeElement.closest('tr') : null;
    const focused = focusedRow?.dataset.id || focusedRow?.dataset.file || null;
    const markerRows = (id) => [
      ...body.querySelectorAll(`tr.files-marker[data-file="${CSS.escape(id)}"]`),
    ];
    const focusedMarker = focusedRow?.dataset.file ? markerRows(focused).indexOf(focusedRow) : -1;
    renderHead();
    const cols = columns();
    body.replaceChildren();
    const openIds = new Set(app.documents.map((d) => d.id));
    for (const id of [...selected]) if (!openIds.has(id)) selected.delete(id);
    if (!selected.size && app.active) selected.add(app.active.id);
    const docs = visibleFiles(app.documents, { query: search.value, sort: sort || { col: null } });
    listed = docs;
    if (!docs.length) {
      body.append(h('tr', h('td.empty-row', { colspan: String(cols.length) }, h('span.empty-text', app.documents.length ? 'No matching files' : 'No open files. Drop audio here or use File > Open.'))));
    }
    autoPlay.checked = Boolean(app.prefs.get('filesAutoPlay'));
    footer.hidden = app.prefs.get('filesPreviewBar') === false;
    for (const doc of docs) {
      const active = doc === app.active;
      const info = doc.kind === 'audio'
        ? {
            duration: app.formatTime(doc.length, doc.sampleRate),
            rate: `${doc.sampleRate} Hz`,
            channels: doc.channelCount === 1 ? 'Mono' : doc.channelCount === 2 ? 'Stereo' : `${doc.channelCount}`,
            bits: doc.info.bitDepth === 32 ? '32 (float)' : String(doc.info.bitDepth ?? ''),
            format: (doc.info.format || '').toUpperCase(),
          }
        : { duration: app.formatTime(doc.length, doc.sampleRate), rate: `${doc.sampleRate} Hz`, channels: 'Stereo', bits: '32 (float)', format: 'Session' };
      info.media = mediaTypeOf(doc);
      info.markers = String(doc.state?.markers?.length || 0);
      info.location = locationOf(doc);
      const row = h(
        `tr${revealed.has(doc.id) ? '.is-revealed' : ''}${active ? '.is-active' : ''}`,
        {
          tabindex: active ? '0' : '-1',
          'aria-selected': String(selected.has(doc.id)),
          draggable: 'true',
          dataset: { id: doc.id },
          ondblclick: () => open(doc),
          onclick: (e) => {
            if (e.target.closest('.files-twisty')) return toggle(doc);
            selectRow(doc, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            if (!selected.has(doc.id)) selectRow(doc);
            rowMenu(e.clientX, e.clientY);
          },
          onkeydown: (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              const next = step(row, e.key === 'ArrowDown' ? 1 : -1);
              const nextDoc = next?.dataset.id && app.documents.find((d) => d.id === next.dataset.id);
              if (e.shiftKey && nextDoc) selectRow(nextDoc, { shift: true });
            } else if (e.key === 'ArrowRight' && !expanded.has(doc.id) && doc.state?.markers?.length) toggle(doc);
            else if (e.key === 'ArrowLeft' && expanded.has(doc.id)) toggle(doc);
            else if (e.key === 'Enter') open(doc);
            // Ctrl/Cmd+Space toggles a row (plain Space stays Play, as everywhere).
            else if (e.key === ' ' && (e.metaKey || e.ctrlKey)) selectRow(doc, { toggle: true });
            else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) selectAll();
            else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              if (!selected.has(doc.id)) selectRow(doc);
              const r = row.getBoundingClientRect();
              rowMenu(r.left + 24, r.bottom);
            } else if (e.key === 'Delete' || e.key === 'Backspace') closeSelected(selected.has(doc.id) ? selectedDocs() : [doc]);
            else return;
            e.preventDefault();
            e.stopPropagation();
          },
          ondragstart: (e) => {
            // Dragging a selected row takes the whole selection, in the listed order.
            const docs = selected.has(doc.id) ? selectedDocs() : [doc];
            e.dataTransfer.setData('application/x-audio-studio-file', docs.map((d) => d.id).join('\n'));
            e.dataTransfer.effectAllowed = 'copy';
          },
        },
        ...cols.map((c) => {
          if (c.id === 'name') {
            return h(
              'td.name-cell',
              h('span.files-twisty', { 'aria-hidden': 'true' }, doc.state?.markers?.length ? icon(expanded.has(doc.id) ? 'chevron-down' : 'chevron-right', 12) : null),
              icon(doc.kind === 'audio' ? 'file-audio' : 'mode-multitrack', 14),
              h('span', doc.name),
            );
          }
          if (c.id === 'status') return h('td', statusCell(doc));
          if (c.id === 'location') return h('td.muted', { title: doc.source?.path || info.location }, info.location);
          return h(c.id === 'duration' || c.id === 'rate' || c.id === 'markers' ? 'td.tabular' : 'td', info[c.id]);
        }),
      );
      if (doc.state?.markers?.length) row.setAttribute('aria-expanded', String(expanded.has(doc.id)));
      body.append(row);
      if (expanded.has(doc.id)) for (const m of doc.state.markers) body.append(markerRow(doc, m));
    }
    // The current file can be filtered out by the search: the list stays in the tab order.
    const firstRow = body.querySelector('tr[data-id]');
    if (firstRow && !body.querySelector('tr[tabindex="0"]')) firstRow.tabIndex = 0;
    const fileRow = focused && body.querySelector(`tr[data-id="${CSS.escape(focused)}"]`);
    if (fileRow) (markerRows(focused)[focusedMarker] || fileRow).focus({ preventScroll: true });
    playBtn.disabled = !app.active;
    playBtn.replaceChildren(icon(app.engine.playing ? 'square' : 'play', app.engine.playing ? 13 : 15));
    loopBtn.setAttribute('aria-pressed', String(app.loop));
    for (const b of toolbar.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
  };

  /** Status column: unsaved changes, and files that have not been saved anywhere yet. */
  function statusCell(doc) {
    if (doc.dirty) return h('span.status-dot', { title: 'Unsaved changes' }, 'Modified');
    if (doc.kind === 'audio' && (!doc.source || doc.source.type === 'new')) return h('span.muted', { title: 'This file has not been saved yet' }, 'New');
    return '';
  }

  /** Moves keyboard focus to the next or previous row, file or marker under an expanded file. */
  function step(row, dir) {
    const rows = [...body.querySelectorAll('tr[data-id], tr.files-marker')];
    const next = rows[rows.indexOf(row) + dir];
    next?.focus();
    return next;
  }

  function toggle(doc) {
    if (expanded.has(doc.id)) expanded.delete(doc.id);
    else expanded.add(doc.id);
    render();
    body.querySelector(`tr[data-id="${doc.id}"]`)?.focus();
  }

  /** A marker under its expanded file: click to go there (range markers select their range). */
  function markerRow(doc, m) {
    const go = () => {
      app.activate(doc);
      if (doc.setSelection) doc.setSelection(m.start, m.start + m.duration);
      doc.setCursor(m.start);
      const v = doc.view;
      if (m.start < v.start || m.start > v.end) doc.setView(m.start - (v.end - v.start) / 3, m.start + ((v.end - v.start) * 2) / 3);
    };
    const keys = (e) => {
      const row = e.currentTarget;
      if (e.key === 'Enter') go();
      else if (e.key === 'ArrowDown') step(row, 1);
      else if (e.key === 'ArrowUp') step(row, -1);
      // Left goes up to the file the marker belongs to.
      else if (e.key === 'ArrowLeft') body.querySelector(`tr[data-id="${CSS.escape(doc.id)}"]`)?.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    return h(
      'tr.files-marker',
      { tabindex: '-1', dataset: { file: doc.id }, onclick: go, onkeydown: keys },
      h('td.name-cell', h('span.files-twisty'), icon(m.duration ? 'bookmark' : 'flag', 12), h('span', m.name || 'Marker')),
      h('td.tabular', { colspan: String(Math.max(1, columns().length - 1)) }, app.formatTime(m.start, doc.sampleRate), m.duration ? ` – ${app.formatTime(m.start + m.duration, doc.sampleRate)}` : ''),
    );
  }

  const toggleColumn = (c) => {
    if (c.optional) {
      const next = extraCols();
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      app.prefs.set('filesExtraColumns', [...next]);
    } else {
      const next = hiddenCols();
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      app.prefs.set('filesHiddenColumns', [...next]);
    }
    render();
  };

  /** Panel menu: file commands, column visibility and the preview footer. */
  const menu = () => {
    const n = selectedDocs().length;
    return [
      ...resolveItems(app, [
        'file.open',
        { id: 'file.import', label: 'Import File...' },
        { id: 'file.newAudio', label: 'New Audio File...' },
      ]),
      { type: 'cmd', label: 'Insert into Multitrack Session', enabled: app.commands.isEnabled('mt.insertFiles'), run: () => insertSelected() },
      { type: 'cmd', label: n > 1 ? `Close ${n} Selected Files` : 'Close Selected File', enabled: n > 0, run: () => closeSelected() },
      ...resolveItems(app, ['file.closeAll']),
      { type: 'sep' },
      {
        type: 'sub',
        label: 'Columns',
        items: FILE_COLUMNS.filter((c) => c.id !== 'name').map((c) => ({
          type: 'cmd',
          label: c.label,
          enabled: true,
          checked: columnShown(c),
          run: () => toggleColumn(c),
        })),
      },
      { type: 'cmd', label: 'Sort by Open Order', enabled: Boolean(sort), run: () => {
        sort = null;
        app.prefs.set('filesSort', null);
        render();
      } },
      { type: 'cmd', label: 'Select All', enabled: listed.length > 1, run: selectAll },
      { type: 'sep' },
      { type: 'cmd', label: 'Show Preview Transport', enabled: true, checked: app.prefs.get('filesPreviewBar') !== false, run: () => {
        app.prefs.set('filesPreviewBar', app.prefs.get('filesPreviewBar') === false);
        render();
      } },
      { type: 'cmd', label: 'Auto-Play', enabled: true, checked: Boolean(app.prefs.get('filesAutoPlay')), run: () => {
        app.prefs.set('filesAutoPlay', !app.prefs.get('filesAutoPlay'));
        render();
      } },
      { type: 'cmd', label: 'Loop Playback', enabled: true, checked: Boolean(app.loop), run: () => app.commands.run('transport.loop') },
    ];
  };

  // Right-click below the rows: the panel menu.
  scroller.addEventListener('contextmenu', (e) => {
    if (e.target.closest('tbody tr[data-id]') || e.defaultPrevented) return;
    e.preventDefault();
    app.openMenu(menu(), { x: e.clientX, y: e.clientY, label: 'Files' });
  });

  app.on('transport', render);
  search.addEventListener('input', render);
  app.on('documents', render);
  app.on('active', (doc) => {
    revealed = new Set();
    // Opening or switching files elsewhere selects just that file.
    if (doc && !selected.has(doc.id)) {
      selected = new Set([doc.id]);
      anchor = doc.id;
    }
    render();
  });
  app.on('reveal-files', (ids) => {
    revealed = new Set(ids);
    if (search.value && app.documents.some((d) => revealed.has(d.id) && !d.name.toLowerCase().includes(search.value.trim().toLowerCase()))) search.value = '';
    render();
    const first = body.querySelector('tr.is-revealed');
    first?.scrollIntoView?.({ block: 'nearest' });
  });
  app.on('doc-change', (doc, e) => {
    if (e.kind === 'edit' || e.kind === 'history' || e.kind === 'saved' || e.kind === 'rename') render();
  });
  render();
  return { el, show: render, menu, api: { selectedDocs, closeSelected, insertSelected, insertInto } };
}
