// Playlist panel: plays the active file's range and cue markers in an order
// you choose. Add the markers selected in the Markers panel (or every range
// marker), reorder, set how many times each entry loops, and play the list
// from the selected entry. Each open file keeps its own playlist for as long
// as it is open (marker ids do not survive saving to audio formats).

import { TIME_DISPLAY_KEYS } from '../lib/time.js';
import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { addMarkers, moveEntries, entryFrames, totalFrames, clampLoops, PlaylistPlayer } from '../model/playlist.js';

const lists = new WeakMap();

/** The playlist entries of a document. */
export function playlistOf(doc) {
  if (!lists.has(doc)) lists.set(doc, []);
  return lists.get(doc);
}

export function setPlaylist(doc, entries) {
  lists.set(doc, entries);
}

export function playlistPanel(app) {
  const player = app.playlistPlayer || (app.playlistPlayer = new PlaylistPlayer(app));
  const selected = new Set();
  const tbtn = (ic, label, onclick) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick }, icon(ic, 15));
  const addSel = tbtn('plus', 'Add Selected Markers', () => add(app.selectedMarkerIds?.() || []));
  const addRanges = tbtn('bookmark-plus', 'Add All Range Markers', () => add(doc().state.markers.filter((m) => m.duration > 0).map((m) => m.id)));
  const remove = tbtn('trash-2', 'Remove from Playlist', () => removeSelected());
  const up = tbtn('chevron-up', 'Move Up', () => move(-1));
  const down = tbtn('chevron-down', 'Move Down', () => move(1));
  const play = h('button.icon-btn.playlist-play', { type: 'button', onclick: () => togglePlay() });
  const toolbar = h('div.panel-toolbar', play, h('span.toolbar-gap'), addSel, addRanges, remove, up, down);
  const body = h('tbody');
  const table = h(
    'table.data-table.playlist-table',
    { role: 'grid', 'aria-label': 'Playlist', 'aria-multiselectable': 'true' },
    h('thead', h('tr', h('th', { scope: 'col' }, 'Name'), h('th.num-col', { scope: 'col' }, 'Loops'), h('th.num-col', { scope: 'col' }, 'Duration'))),
    body,
  );
  const total = h('span.tabular');
  const el = h('div.playlist-panel', toolbar, h('div.table-scroll', table), h('div.panel-footer', h('span.muted', 'Total Duration:'), total));

  const doc = () => (app.active && app.active.state?.markers ? app.active : null);
  const entries = () => (doc() ? playlistOf(doc()) : []);
  const commit = (next) => {
    setPlaylist(doc(), next);
    render();
  };

  function add(ids) {
    const d = doc();
    if (!d) return;
    if (!ids.length) {
      app.notify('Select markers in the Markers panel first.');
      return;
    }
    // In marker order, so a multi-selection adds front to back.
    const order = d.state.markers.filter((m) => ids.includes(m.id)).map((m) => m.id);
    commit(addMarkers(entries(), order));
  }

  function removeSelected() {
    if (!selected.size) return;
    const list = entries();
    const first = list.findIndex((e) => selected.has(e.id));
    const next = list.filter((e) => !selected.has(e.id));
    selected.clear();
    if (next.length) selected.add(next[Math.min(first, next.length - 1)].id);
    commit(next);
  }

  function move(delta) {
    if (selected.size) commit(moveEntries(entries(), [...selected], delta));
  }

  function togglePlay() {
    if (player.running) {
      player.stop();
      return;
    }
    const list = entries();
    const from = Math.max(0, list.findIndex((e) => selected.has(e.id)));
    if (!player.start(doc(), list, from)) app.notify('The playlist has nothing to play.');
  }

  const select = (id, e) => {
    if (e?.metaKey || e?.ctrlKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else if (e?.shiftKey && selected.size) {
      const list = entries();
      const anchor = list.findIndex((x) => selected.has(x.id));
      const i = list.findIndex((x) => x.id === id);
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(list[k].id);
    } else {
      selected.clear();
      selected.add(id);
    }
    render();
    body.querySelector(`tr[data-id="${id}"]`)?.focus();
  };

  function render() {
    // Rows are rebuilt (playback moving on, entries removed): keyboard focus stays in the list.
    const focusedRow = body.contains(document.activeElement) ? document.activeElement.closest('tr[data-id]') : null;
    const focusedAt = focusedRow ? [...body.querySelectorAll('tr[data-id]')].indexOf(focusedRow) : -1;
    const d = doc();
    const list = entries();
    for (const id of [...selected]) if (!list.some((e) => e.id === id)) selected.delete(id);
    const markers = d?.state.markers || [];
    const current = player.current?.entryId;
    body.replaceChildren();
    if (!d) body.append(h('tr', h('td.empty-row', { colspan: '3' }, h('span.empty-text', 'No file open'))));
    else if (!list.length) body.append(h('tr', h('td.empty-row', { colspan: '3' }, h('span.empty-text', markers.length ? 'Select markers in the Markers panel and add them here, or add all range markers.' : 'This file has no markers. Add range markers to build a playlist.'))));
    for (const e of list) {
      const m = markers.find((x) => x.id === e.markerId);
      const loops = h('input.input.num.playlist-loops', {
        type: 'number',
        min: 1,
        max: 99,
        value: e.loops,
        'aria-label': `Loops for ${m?.name || 'entry'}`,
        onclick: (ev) => ev.stopPropagation(),
        onkeydown: (ev) => ev.stopPropagation(),
        onchange: () => {
          const n = clampLoops(loops.value);
          commit(entries().map((x) => (x.id === e.id ? { ...x, loops: n } : x)));
        },
      });
      const frames = entryFrames(e, markers, d.length);
      const isSel = selected.has(e.id);
      body.append(
        h(
          `tr${m ? '' : '.missing'}${e.id === current ? '.playing' : ''}`,
          {
            tabindex: isSel ? '0' : '-1',
            'aria-selected': String(isSel),
            dataset: { id: e.id },
            onclick: (ev) => select(e.id, ev),
            ondblclick: () => {
              selected.clear();
              selected.add(e.id);
              player.start(d, entries(), entries().indexOf(e));
            },
          },
          h('td.name-cell', icon(e.id === current ? 'transport-play' : m && !m.duration ? 'flag' : 'bookmark', 13), h('span', m ? m.name || 'Untitled' : 'Deleted marker')),
          h('td.num-col', loops),
          h('td.num-col.tabular', m ? app.formatTime(frames, d.sampleRate) : ''),
        ),
      );
    }
    if (!body.querySelector('tr[tabindex="0"]')) body.querySelector('tr[data-id]')?.setAttribute('tabindex', '0');
    if (focusedRow && (!document.activeElement || document.activeElement === document.body)) {
      const rows = [...body.querySelectorAll('tr[data-id]')];
      const same = rows.find((r) => r.dataset.id === focusedRow.dataset.id);
      (same || body.querySelector('tr[tabindex="0"]') || rows[Math.min(focusedAt, rows.length - 1)])?.focus({ preventScroll: Boolean(same) });
    }
    total.textContent = d ? app.formatTime(totalFrames(list, markers, d.length), d.sampleRate) : '';
    const has = Boolean(d);
    addSel.disabled = !has || !markers.length;
    addRanges.disabled = !has || !markers.some((m) => m.duration > 0);
    remove.disabled = !selected.size;
    up.disabled = !selected.size || list.findIndex((e) => selected.has(e.id)) <= 0;
    down.disabled = !selected.size || list.findLastIndex((e) => selected.has(e.id)) >= list.length - 1;
    play.replaceChildren(icon(player.running ? 'transport-stop' : 'transport-play', 15));
    const label = player.running ? 'Stop Playlist' : 'Play from Selected Entry';
    play.title = label;
    play.setAttribute('aria-label', label);
    play.setAttribute('aria-pressed', String(player.running));
    play.disabled = !player.running && totalFrames(list, markers, d?.length || 0) === 0;
  }

  body.addEventListener('keydown', (e) => {
    const rows = [...body.querySelectorAll('tr[data-id]')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' && rows[i + 1]) select(rows[i + 1].dataset.id, e.shiftKey ? { shiftKey: true } : null);
    else if (e.key === 'ArrowUp' && rows[i - 1]) select(rows[i - 1].dataset.id, e.shiftKey ? { shiftKey: true } : null);
    else if (e.key === 'Enter') togglePlay();
    else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  player.on('change', render);
  app.on('active', () => {
    selected.clear();
    render();
  });
  app.on('doc-change', (d, e) => d === app.active && (e.kind === 'edit' || e.kind === 'history') && render());
  app.on('prefs', (key) => TIME_DISPLAY_KEYS.has(key) && render());
  app.on('playlist', (d) => d === app.active && render());
  render();
  return {
    el,
    render,
    show: render,
    menu: () => [
      { type: 'cmd', label: player.running ? 'Stop Playlist' : 'Play from Selected Entry', enabled: player.running || !play.disabled, run: togglePlay },
      { type: 'sep' },
      { type: 'cmd', label: 'Add Selected Markers', enabled: !addSel.disabled, run: () => add(app.selectedMarkerIds?.() || []) },
      { type: 'cmd', label: 'Add All Range Markers', enabled: !addRanges.disabled, run: () => add(doc().state.markers.filter((m) => m.duration > 0).map((m) => m.id)) },
      { type: 'sep' },
      { type: 'cmd', label: 'Remove Selected Entries', enabled: !remove.disabled, run: removeSelected },
      { type: 'cmd', label: 'Clear Playlist', enabled: entries().length > 0, run: () => commit([]) },
    ],
  };
}
