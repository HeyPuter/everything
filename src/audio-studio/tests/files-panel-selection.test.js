// Files panel: several files selected at once, the row context menu, the
// optional columns and dragging the selection.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { clickSelection, locationOf, mediaTypeOf } from '../src/panels/files.js';

const RATE = 1000;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

function setup(n = 3) {
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const docs = [];
  for (let i = 0; i < n; i++) {
    const d = new AudioFile({ name: `${String.fromCharCode(97 + i)}.wav`, sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE))] });
    app.addDocument(d);
    docs.push(d);
  }
  const panel = app.panels.get('files').create(app);
  document.body.replaceChildren(panel.el);
  const row = (d) => panel.el.querySelector(`tr[data-id="${d.id}"]`);
  const click = (d, opts = {}) => row(d).dispatchEvent(new MouseEvent('click', { bubbles: true, ...opts }));
  const selectedIds = () => [...panel.el.querySelectorAll('tr[aria-selected=true]')].map((r) => r.dataset.id);
  return { app, docs, panel, row, click, selectedIds };
}

describe('clickSelection', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('picks, toggles and extends from the anchor', () => {
    expect([...clickSelection(new Set(['a']), ids, 'c', 'a')]).toEqual(['c']);
    expect([...clickSelection(new Set(['a']), ids, 'c', 'a', { toggle: true })]).toEqual(['a', 'c']);
    expect([...clickSelection(new Set(['a', 'c']), ids, 'c', 'a', { toggle: true })]).toEqual(['a']);
    expect([...clickSelection(new Set(['d']), ids, 'b', 'd', { shift: true })]).toEqual(['b', 'c', 'd']);
    // No usable anchor: a plain pick.
    expect([...clickSelection(new Set(), ids, 'b', 'zz', { shift: true })]).toEqual(['b']);
  });
});

describe('Files panel selection', () => {
  it('selects several files with Shift and Ctrl/Cmd clicks without changing the active file', () => {
    const { app, docs, click, selectedIds } = setup();
    click(docs[0]);
    expect(app.active).toBe(docs[0]);
    expect(selectedIds()).toEqual([docs[0].id]);
    click(docs[2], { shiftKey: true });
    expect(selectedIds()).toEqual(docs.map((d) => d.id));
    expect(app.active).toBe(docs[0]);
    click(docs[1], { metaKey: true });
    expect(selectedIds()).toEqual([docs[0].id, docs[2].id]);
    // A plain click picks one again and activates it.
    click(docs[1]);
    expect(selectedIds()).toEqual([docs[1].id]);
    expect(app.active).toBe(docs[1]);
  });

  it('marks the active file separately from the selection', () => {
    const { docs, row, click } = setup();
    click(docs[0]);
    click(docs[1], { metaKey: true });
    expect(row(docs[0]).classList.contains('is-active')).toBe(true);
    expect(row(docs[1]).classList.contains('is-active')).toBe(false);
    expect(row(docs[1]).getAttribute('aria-selected')).toBe('true');
  });

  it('extends the selection with Shift+Arrow and selects all with Mod+A', () => {
    const { docs, row, click, selectedIds } = setup();
    click(docs[0]);
    row(docs[0]).focus();
    row(docs[0]).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(selectedIds()).toEqual([docs[0].id, docs[1].id]);
    expect(document.activeElement).toBe(row(docs[1]));
    row(docs[1]).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    expect(selectedIds()).toHaveLength(3);
  });

  it('closes every selected file with Delete', async () => {
    const { app, docs, row, click } = setup();
    click(docs[0]);
    click(docs[1], { shiftKey: true });
    row(docs[1]).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await vi.waitFor(() => expect(app.documents).toEqual([docs[2]]));
  });

  it('drags the whole selection as one id per line', () => {
    const { docs, row, click } = setup();
    click(docs[0]);
    click(docs[2], { metaKey: true });
    const data = {};
    const ev = new Event('dragstart', { bubbles: true });
    ev.dataTransfer = { setData: (t, v) => (data[t] = v), effectAllowed: '' };
    row(docs[2]).dispatchEvent(ev);
    expect(data['application/x-audio-studio-file']).toBe(`${docs[0].id}\n${docs[2].id}`);
    // An unselected row drags alone.
    const ev2 = new Event('dragstart', { bubbles: true });
    ev2.dataTransfer = { setData: (t, v) => (data[t] = v), effectAllowed: '' };
    row(docs[1]).dispatchEvent(ev2);
    expect(data['application/x-audio-studio-file']).toBe(docs[1].id);
  });

  it('opens a context menu with commands for the selected files', () => {
    const { app, docs, row, click } = setup();
    const menus = [];
    app.openMenu = (items) => menus.push(items);
    const runs = [];
    const orig = app.commands.run.bind(app.commands);
    app.commands.run = (id, args) => (id === 'mt.insertFiles' ? runs.push([id, args]) : orig(id, args));
    click(docs[0]);
    click(docs[1], { shiftKey: true });
    row(docs[1]).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const items = menus[0];
    const labels = items.filter((i) => i.label).map((i) => i.label);
    expect(labels).toContain('Insert 2 Files into Multitrack Session');
    expect(labels).toContain('Close 2 Files');
    expect(items.find((i) => i.label === 'Open in Editor').enabled).toBe(false);
    items.find((i) => i.label === 'Insert 2 Files into Multitrack Session').run();
    expect(runs[0][1].docs).toEqual([docs[0], docs[1]]);
    // Right-clicking an unselected row selects just it.
    row(docs[2]).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menus[1].find((i) => i.label === 'Open in Editor').enabled).toBe(true);
    expect(app.active).toBe(docs[2]);
  });

  it('shows the optional columns from the panel menu', () => {
    const { app, docs, panel } = setup(1);
    docs[0].source = { type: 'puter', path: '/me/Music/a.wav' };
    const header = (label) => [...panel.el.querySelectorAll('th')].find((th) => th.textContent === label);
    expect(header('Location')).toBeUndefined();
    const cols = panel.menu().find((i) => i.label === 'Columns');
    expect(cols.items.find((i) => i.label === 'Location').checked).toBe(false);
    cols.items.find((i) => i.label === 'Location').run();
    expect(header('Location')).toBeTruthy();
    expect(app.prefs.get('filesExtraColumns')).toEqual(['location']);
    expect(panel.el.querySelector('tbody td.muted').textContent).toBe('/me/Music');
  });
});

describe('column values', () => {
  it('describes where a file lives and its media type', () => {
    expect(locationOf({ source: { type: 'puter', path: '/u/a.wav' } })).toBe('/u');
    expect(locationOf({ source: { type: 'local' } })).toBe('This device');
    expect(locationOf({})).toBe('Not saved');
    expect(mediaTypeOf({ kind: 'session' })).toBe('Multitrack Session');
    expect(mediaTypeOf({ kind: 'audio', state: {} })).toBe('Audio');
  });
});
