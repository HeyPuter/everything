// Files panel: every open audio file and session with its format details.
// Double-click or Enter opens one in the editor; Delete closes it; rows can be
// dragged into a multitrack session (dataTransfer type application/x-audio-studio-file).
// The app event 'reveal-files' (file ids) highlights the files behind clips.
// The disclosure arrow lists a file's markers (click one to go there); the
// footer plays the selected file from its start, loops, and can auto-play
// files as they are picked. Column headers sort; the panel menu shows or hides
// columns and the preview footer.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { resolveItems } from '../ui/menubar.js';

const bitsOf = (doc) => (doc.kind === 'audio' ? doc.info.bitDepth ?? 0 : 32);
const channelsOf = (doc) => (doc.kind === 'audio' ? doc.channelCount : 2);

export const FILE_COLUMNS = [
  { id: 'name', label: 'Name', key: (d) => d.name.toLowerCase() },
  { id: 'status', label: 'Status', key: (d) => (d.dirty ? 1 : 0) },
  { id: 'duration', label: 'Duration', key: (d) => d.length / d.sampleRate },
  { id: 'rate', label: 'Sample Rate', key: (d) => d.sampleRate },
  { id: 'channels', label: 'Channels', key: channelsOf },
  { id: 'bits', label: 'Bit Depth', key: bitsOf },
  { id: 'format', label: 'Format', key: (d) => (d.kind === 'audio' ? (d.info.format || '').toLowerCase() : '~session') },
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

export function filesPanel(app) {
  const search = h('input.input.panel-search', { type: 'search', placeholder: 'Search files', 'aria-label': 'Search files' });
  const tbtn = (cmd, ic, label) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: () => app.commands.run(cmd), dataset: { cmd } }, icon(ic, 15));
  const toolbar = h(
    'div.panel-toolbar',
    tbtn('file.open', 'folder-open', 'Open'),
    tbtn('file.import', 'download', 'Import'),
    tbtn('file.newAudio', 'file-plus', 'New Audio File'),
    tbtn('mt.insertFiles', 'mode-multitrack', 'Insert into Multitrack'),
    tbtn('file.close', 'trash-2', 'Close'),
    search,
  );
  const head = h('tr');
  // Open order until a header is clicked.
  let sort = app.prefs.get('filesSort') || null;
  const hiddenCols = () => new Set(app.prefs.get('filesHiddenColumns') || []);
  const columns = () => FILE_COLUMNS.filter((c) => c.id === 'name' || !hiddenCols().has(c.id));
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
  const table = h('table.data-table', { role: 'grid', 'aria-label': 'Open files' }, h('thead', head), body);
  const playBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Play from Start', title: 'Play from Start' }, icon('play', 15));
  const loopBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Loop Playback', title: 'Loop Playback', dataset: { cmd: 'transport.loop' }, onclick: () => app.commands.run('transport.loop') }, icon('repeat', 15));
  const autoPlay = h('input', { type: 'checkbox', checked: Boolean(app.prefs.get('filesAutoPlay')), onchange: (e) => app.prefs.set('filesAutoPlay', e.target.checked) });
  playBtn.addEventListener('click', () => {
    if (!app.active) return;
    if (app.engine.playing) app.stop();
    else app.play({ from: 0 });
  });
  const footer = h('div.panel-footer.files-footer', { hidden: app.prefs.get('filesPreviewBar') === false }, playBtn, loopBtn, h('label.check', { title: 'Play files as you select them' }, autoPlay, 'Auto-play'));
  const el = h('div.files-panel', toolbar, h('div.table-scroll', table), footer);
  const expanded = new Set();
  const pick = (doc) => {
    const changed = app.active !== doc;
    app.activate(doc);
    if (changed && autoPlay.checked) app.play({ from: 0 });
  };

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
    const docs = visibleFiles(app.documents, { query: search.value, sort: sort || { col: null } });
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
      const row = h(
        `tr${revealed.has(doc.id) ? '.is-revealed' : ''}`,
        {
          tabindex: active ? '0' : '-1',
          'aria-selected': String(active),
          draggable: 'true',
          dataset: { id: doc.id },
          ondblclick: () => {
            app.activate(doc);
            app.dock.openPanel('editor');
          },
          onclick: (e) => (e.target.closest('.files-twisty') ? toggle(doc) : pick(doc)),
          onkeydown: (e) => {
            if (e.key === 'ArrowDown') step(row, 1);
            else if (e.key === 'ArrowUp') step(row, -1);
            else if (e.key === 'ArrowRight' && !expanded.has(doc.id) && doc.state?.markers?.length) toggle(doc);
            else if (e.key === 'ArrowLeft' && expanded.has(doc.id)) toggle(doc);
            else if (e.key === 'Enter') {
              app.activate(doc);
              app.dock.openPanel('editor');
            } else if (e.key === 'Delete' || e.key === 'Backspace') app.closeDocument(doc);
            else return;
            e.preventDefault();
            e.stopPropagation();
          },
          ondragstart: (e) => {
            e.dataTransfer.setData('application/x-audio-studio-file', doc.id);
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
          if (c.id === 'status') return h('td', doc.dirty ? h('span.status-dot', { title: 'Unsaved changes' }, 'Modified') : '');
          return h(c.id === 'duration' || c.id === 'rate' ? 'td.tabular' : 'td', info[c.id]);
        }),
      );
      if (doc.state?.markers?.length) row.setAttribute('aria-expanded', String(expanded.has(doc.id)));
      body.append(row);
      if (expanded.has(doc.id)) for (const m of doc.state.markers) body.append(markerRow(doc, m));
    }
    const fileRow = focused && body.querySelector(`tr[data-id="${CSS.escape(focused)}"]`);
    if (fileRow) (markerRows(focused)[focusedMarker] || fileRow).focus({ preventScroll: true });
    playBtn.disabled = !app.active;
    playBtn.replaceChildren(icon(app.engine.playing ? 'square' : 'play', app.engine.playing ? 13 : 15));
    loopBtn.setAttribute('aria-pressed', String(app.loop));
    for (const b of toolbar.querySelectorAll('[data-cmd]')) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
  };
  /** Moves keyboard focus to the next or previous row, file or marker under an expanded file. */
  function step(row, dir) {
    const rows = [...body.querySelectorAll('tr[data-id], tr.files-marker')];
    rows[rows.indexOf(row) + dir]?.focus();
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

  /** Panel menu: file commands, column visibility and the preview footer. */
  const menu = () => {
    const hidden = hiddenCols();
    return [
      ...resolveItems(app, [
        'file.open',
        { id: 'file.import', label: 'Import File...' },
        { id: 'file.newAudio', label: 'New Audio File...' },
        { id: 'mt.insertFiles', label: 'Insert into Multitrack Session' },
        'file.close',
        'file.closeAll',
      ]),
      { type: 'sep' },
      {
        type: 'sub',
        label: 'Columns',
        items: FILE_COLUMNS.filter((c) => c.id !== 'name').map((c) => ({
          type: 'cmd',
          label: c.label,
          enabled: true,
          checked: !hidden.has(c.id),
          run: () => {
            const next = hiddenCols();
            if (next.has(c.id)) next.delete(c.id);
            else next.add(c.id);
            app.prefs.set('filesHiddenColumns', [...next]);
            render();
          },
        })),
      },
      { type: 'cmd', label: 'Sort by Open Order', enabled: Boolean(sort), run: () => {
        sort = null;
        app.prefs.set('filesSort', null);
        render();
      } },
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

  app.on('transport', render);
  search.addEventListener('input', render);
  app.on('documents', render);
  app.on('active', () => {
    revealed = new Set();
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
  return { el, show: render, menu };
}
