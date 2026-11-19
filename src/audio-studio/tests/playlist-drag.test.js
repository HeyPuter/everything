// Playlist: markers dragged from the Markers panel drop where they land,
// entries drag to a new place, Alt+Up/Down moves the selected entries.
import { describe, it, expect } from 'vitest';
import { insertMarkersAt, moveEntriesTo } from '../src/model/playlist.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { MARKERS_DRAG_TYPE } from '../src/panels/playlist.js';

const RATE = 1000;

async function setup() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installPanelsExtra } = await import('../src/features/panels-extra.js');
  const app = new App();
  installCore(app);
  installPanelsExtra(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE * 6))] });
  const mk = (id, start) => ({ id, name: id, start, duration: 500, type: 'cue', description: '' });
  doc.apply('Markers', { ...doc.state, markers: [mk('A', 0), mk('B', 1000), mk('C', 2000), mk('D', 3000)] });
  app.addDocument(doc);
  const markers = app.panels.get('markers').create(app);
  const playlist = app.panels.get('playlist').create(app);
  document.body.replaceChildren(markers.el, playlist.el);
  return { app, doc, markers, playlist };
}

/** A drag event carrying a shared data store (jsdom has no DataTransfer). */
function dragEvent(type, store, { clientY = 0 } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.clientY = clientY;
  e.dataTransfer = {
    get types() {
      return Object.keys(store);
    },
    setData: (t, v) => (store[t] = v),
    getData: (t) => store[t] || '',
    dropEffect: '',
    effectAllowed: '',
  };
  return e;
}

const names = (playlist) => [...playlist.el.querySelectorAll('tbody tr[data-id] .name-cell')].map((c) => c.textContent);

describe('playlist model drag helpers', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id, markerId: `m${id}`, loops: 1 }));
  it('inserts new markers at an index and skips listed ones', () => {
    const out = insertMarkersAt(list, ['mb', 'mx', 'my'], 1);
    expect(out.map((e) => e.markerId)).toEqual(['ma', 'mx', 'my', 'mb', 'mc', 'md']);
  });
  it('moves entries before an index of the current list', () => {
    expect(moveEntriesTo(list, ['d'], 0).map((e) => e.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveEntriesTo(list, ['a', 'b'], 4).map((e) => e.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(moveEntriesTo(list, ['a'], 2).map((e) => e.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveEntriesTo(list, ['zz'], 2)).toBe(list);
  });
});

describe('dragging markers into the playlist', () => {
  it('drops the dragged markers into the playlist and reorders entries by dragging', async () => {
    const { markers, playlist } = await setup();
    const rows = () => [...markers.el.querySelectorAll('tbody tr[data-id]')];
    // Select B and D, drag them over.
    rows()[1].click();
    rows()[3].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    const store = {};
    rows()[3].dispatchEvent(dragEvent('dragstart', store));
    expect(JSON.parse(store[MARKERS_DRAG_TYPE]).ids).toEqual(['B', 'D']);
    const scroller = playlist.el.querySelector('.table-scroll');
    const over = dragEvent('dragover', store);
    scroller.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    scroller.dispatchEvent(dragEvent('drop', store));
    expect(names(playlist)).toEqual(['B', 'D']);
    // A, dragged alone (unselected), lands at the end (jsdom rows have no height).
    const store2 = {};
    rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); // toggles A in
    rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); // and out again
    rows()[0].dispatchEvent(dragEvent('dragstart', store2));
    expect(JSON.parse(store2[MARKERS_DRAG_TYPE]).ids).toEqual(['A']);
    scroller.dispatchEvent(dragEvent('drop', store2));
    expect(names(playlist)).toEqual(['B', 'D', 'A']);
    // Alt+Up moves the selected entry (A, just dropped) up one place.
    const sel = playlist.el.querySelector('tbody tr[aria-selected=true]');
    expect(sel.textContent).toContain('A');
    sel.focus();
    sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(names(playlist)).toEqual(['B', 'A', 'D']);
    // Drag entry B to the end.
    const pRows = [...playlist.el.querySelectorAll('tbody tr[data-id]')];
    const store3 = {};
    pRows[0].dispatchEvent(dragEvent('dragstart', store3));
    scroller.dispatchEvent(dragEvent('drop', store3, { clientY: 9999 }));
    expect(names(playlist)).toEqual(['A', 'D', 'B']);
  });
});
