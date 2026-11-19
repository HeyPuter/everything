// Panel (≡) menus built from the panels' own controls: the dock falls back to
// the panel instance's menu when the registration has none.
import { describe, it, expect, beforeAll } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installAnalysis } from '../src/analysis/install.js';
import { installIo } from '../src/features/io.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';

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
  installAnalysis(app);
  installIo(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(2000))] });
  app.addDocument(doc);
  return { app, doc };
}

const labels = (items) => items.filter((i) => i.label).map((i) => i.label);

describe('panel menus', () => {
  it('Markers lists add, organize, export and filter commands', () => {
    const { app, doc } = setup();
    doc.apply('M', { ...doc.state, markers: [{ id: 'm', name: 'A', start: 0, duration: 500, type: 'cue', description: '' }] });
    const panel = app.panels.get('markers').create(app);
    const items = panel.menu();
    expect(labels(items)).toEqual(expect.arrayContaining(['Add Cue Marker', 'Merge Selected Markers', 'Export Markers...', 'Select All']));
    items.find((i) => i.label === 'Select All').run();
    expect(app.selectedMarkerIds()).toEqual(['m']);
  });

  it('Metadata clears a tab or everything as one undoable edit', () => {
    const { app, doc } = setup();
    doc.apply('Meta', { ...doc.state, meta: { title: 'T', bextOriginator: 'Rec' } });
    const panel = app.panels.get('metadata').create(app);
    app.prefs.set('metadataTab', 'bwf');
    panel.menu().find((i) => i.label === 'Clear BWF Fields').run();
    expect(doc.state.meta).toEqual({ title: 'T' });
    panel.menu().find((i) => i.label === 'Clear All Metadata').run();
    expect(doc.state.meta).toEqual({});
    doc.history.undo();
    expect(doc.state.meta).toEqual({ title: 'T' });
  });

  it('Amplitude Statistics, Frequency Analysis and Selection/View have menus', () => {
    const { app } = setup();
    expect(labels(app.panels.get('amplitude').create(app).menu())).toEqual(['Scan Selection', 'Scan File', 'Cancel Scan', 'Copy All']);
    const freq = app.panels.get('frequency').create(app);
    freq.menu().find((i) => i.label === 'Linear Scale').run();
    expect(app.prefs.get('frequencyAnalysis').log).toBe(false);
    expect(freq.menu().find((i) => i.label === 'Linear Scale').checked).toBe(true);
    const sel = app.panels.get('selection').create(app);
    expect(labels(sel.menu())).toEqual(expect.arrayContaining(['Select All']));
  });

  it('the dock uses the instance menu when the registration has none', async () => {
    const { Dock } = await import('../src/ui/dock.js');
    const root = document.createElement('div');
    document.body.append(root);
    const opened = [];
    const app = { openMenu: (items) => opened.push(items) };
    const registry = new Map([['p', { id: 'p', title: 'P', create: () => ({ el: document.createElement('div'), menu: () => [{ type: 'cmd', label: 'Own Item', enabled: true, run() {} }] }) }]]);
    const dock = new Dock(app, root, registry);
    dock.setLayout({ t: 'group', tabs: ['p'], a: 'p' });
    root.querySelector('.panel-menu-btn').click();
    expect(opened[0][0].label).toBe('Own Item');
    expect(opened[0].some((i) => i.label === 'Close Panel')).toBe(true);
    root.remove();
  });
});

describe('Media Browser menu', () => {
  it('lists the browsing and preview options', () => {
    const { app } = setup();
    const panel = app.panels.get('media').create(app);
    const items = panel.menu();
    expect(labels(items)).toEqual(expect.arrayContaining(['Open', 'Insert into Multitrack', 'Refresh', 'Show Only Audio Files', 'Auto-Play', 'Loop Preview']));
    expect(items.find((i) => i.label === 'Open').enabled).toBe(false);
    items.find((i) => i.label === 'Auto-Play').run();
    expect(app.prefs.get('mediaAutoPlay')).toBe(true);
  });
});
