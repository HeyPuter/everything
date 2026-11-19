// History panel snapshots: named states kept while the file is open,
// restored as an undoable edit, surviving a cleared history.
import { describe, it, expect, beforeAll } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { snapshotsOf, addSnapshot, restoreSnapshot } from '../src/panels/history.js';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(1000))] });
  app.addDocument(doc);
  const panel = app.panels.get('history').create(app);
  document.body.replaceChildren(panel.el);
  panel.show();
  return { app, doc, panel };
}

const title = (doc) => doc.state.meta?.title;

describe('history snapshots', () => {
  it('keeps a snapshot across later edits and a cleared history, and restores it as an edit', () => {
    const { doc, panel } = setup();
    doc.apply('One', { ...doc.state, meta: { title: '1' } });
    panel.el.querySelector('[aria-label="New Snapshot"]').click();
    expect(snapshotsOf(doc).map((s) => s.name)).toEqual(['Snapshot 1']);
    expect(panel.el.querySelector('.history-snapshot').getAttribute('aria-selected')).toBe('true');
    doc.apply('Two', { ...doc.state, meta: { title: '2' } });
    doc.history.clear();
    expect(panel.el.querySelector('.history-snapshot').getAttribute('aria-selected')).toBe('false');
    panel.el.querySelector('.history-snapshot').click();
    expect(title(doc)).toBe('1');
    expect(doc.history.entries.at(-1).label).toBe('Restore Snapshot 1');
    doc.history.undo();
    expect(title(doc)).toBe('2');
  });

  it('snapshots an earlier state from its context menu, and hides the section when empty', () => {
    const { app, doc, panel } = setup();
    expect(panel.el.querySelector('.history-snapshots').hidden).toBe(true);
    doc.apply('One', { ...doc.state, meta: { title: '1' } });
    doc.apply('Two', { ...doc.state, meta: { title: '2' } });
    const menus = [];
    app.openMenu = (items) => menus.push(items);
    const rows = panel.el.querySelectorAll('.history-list:not(.history-snapshots) .history-item');
    rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menus[0].find((i) => i.label === 'New Snapshot of This State').run();
    expect(snapshotsOf(doc)[0].state.meta.title).toBe('1');
    expect(panel.el.querySelector('.history-snapshots').hidden).toBe(false);
    panel.menu().find((i) => i.label === 'Delete All Snapshots').run();
    expect(snapshotsOf(doc)).toEqual([]);
  });

  it('does nothing when the document is already in the snapshot state', () => {
    const { doc } = setup();
    const snap = addSnapshot(doc, { name: 'Here' });
    expect(restoreSnapshot(doc, snap)).toBe(false);
    expect(doc.history.entries).toHaveLength(1);
  });
});
