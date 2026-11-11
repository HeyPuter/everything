// Regression tests for the waveform editor, shell and dialog QA pass.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Overview } from '../src/editor/overview.js';

/** A 2D context stand-in: every method is a no-op, every property settable. */
function fakeContext() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

describe('overview navigator', () => {
  it('recomputes its peaks after an edit that keeps the length', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    let state = { id: 1 };
    const host = {
      timeline: () => ({ rate: 48000, length: 48000, view: { start: 0, end: 48000 }, cursor: 0, selection: { start: 0, end: 0 } }),
      overviewPeaks: vi.fn((cols) => new Float32Array(cols * 2)),
      peaksKey: () => state,
      setView() {},
    };
    const o = new Overview({}, host);
    o.resize(100, 20);
    o.draw();
    o.draw();
    expect(host.overviewPeaks).toHaveBeenCalledTimes(1);
    state = { id: 2 }; // a new document state with the same length
    o.draw();
    expect(host.overviewPeaks).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('waveform view redraws', () => {
  async function makeView() {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const { WaveformView } = await import('../src/editor/waveform-view.js');
    HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
    localStorage.clear();
    const app = new App();
    installCore(app);
    app.syncGraph = () => {};
    const doc = new AudioFile({ name: 's.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000)), Channel.fromSamples(new Float32Array(48000))] });
    app.addDocument(doc);
    const view = new WaveformView(app, doc);
    document.body.replaceChildren(view.el);
    view.layout();
    view.width = 400;
    view.height = 200;
    view.frame();
    return { app, doc, view };
  }

  it('does not redraw the waveform for a time selection change', async () => {
    const { doc, view } = await makeView();
    const draw = vi.spyOn(view.renderer, 'draw');
    doc.setSelection(100, 2000);
    view.frame();
    doc.setSelection(100, 4000);
    view.frame();
    expect(draw).not.toHaveBeenCalled();
    doc.setChannelEnabled(1, false);
    view.frame();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('keeps the channel button focused after toggling it', async () => {
    const { doc, view } = await makeView();
    const b = view.el.querySelectorAll('.channel-btn')[0];
    b.focus();
    b.click();
    expect(doc.selection.channels).toEqual([false, true]);
    expect(b.isConnected).toBe(true);
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute('aria-pressed')).toBe('false');
    b.click();
    expect(doc.selection.channels).toEqual([true, true]);
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('dock tab overflow', () => {
  it('offers a menu of every panel in a group and activates the chosen one', async () => {
    const { Dock } = await import('../src/ui/dock.js');
    const registry = new Map(['a', 'b', 'c'].map((id) => [id, { id, title: id.toUpperCase(), create: () => ({ el: document.createElement('div') }) }]));
    let menu = null;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu: (items) => (menu = items) }, root, registry);
    dock.setLayout({ t: 'group', tabs: ['a', 'b', 'c'], a: 'a' });
    const more = root.querySelector('.panel-tabs-more');
    expect(more.getAttribute('aria-label')).toBeTruthy();
    more.click();
    expect(menu.map((i) => i.label)).toEqual(['A', 'B', 'C']);
    expect(menu[0].checked).toBe(true);
    menu[2].run();
    expect(dock.isVisible('c')).toBe(true);
  });
});

describe('amplitude ruler ticks', () => {
  it('places ticks only where labels fit and mirrors them below the centre', async () => {
    const { dbTicks } = await import('../src/editor/waveform-view.js');
    const ticks = dbTicks({ top: 0, bottom: 260 }, 1);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      expect(t.y).toBeLessThan(130);
      if (t.y2 !== null) expect(t.y2 - 130).toBeCloseTo(130 - t.y, 6);
    }
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].y - ticks[i - 1].y).toBeGreaterThanOrEqual(13);
  });
});

describe('Effects > Diagnostics', () => {
  it('opens the Diagnostics panel on the chosen diagnostic and states the DeClipper gain', async () => {
    const { App } = await import('../src/app.js');
    const { FEATURES } = await import('../src/features.js');
    const { Dock } = await import('../src/ui/dock.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
    localStorage.clear();
    const app = new App();
    for (const install of FEATURES) install(app);
    app.syncGraph = () => {};
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    app.dock = new Dock(app, root, app.panels);
    app.dock.setLayout({ t: 'group', tabs: ['properties'], a: 'properties' });
    app.addDocument(new AudioFile({ name: 'd.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(4800))] }));
    await app.commands.run('fx.declipper');
    expect(app.dock.isVisible('diagnostics')).toBe(true);
    expect(document.querySelector('[dialog], .dialog-backdrop')).toBeNull();
    const panel = root.querySelector('.diag-panel');
    expect(panel.querySelector('.diag-effect').value).toBe('declipper');
    const note = panel.querySelector('.diag-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/-3\.0 dB/);
    await app.commands.run('fx.markAudio');
    expect(panel.querySelector('.diag-effect').value).toBe('markAudio');
    expect(note.hidden).toBe(true);
  });
});

describe('dock tabs', () => {
  it('points aria-controls only at a panel body that exists', async () => {
    const { Dock } = await import('../src/ui/dock.js');
    const registry = new Map(['a', 'b'].map((id) => [id, { id, title: id, create: () => ({ el: document.createElement('div') }) }]));
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    new Dock({ openMenu() {} }, root, registry).setLayout({ t: 'group', tabs: ['a', 'b'], a: 'a' });
    for (const tab of root.querySelectorAll('[role=tab]')) {
      const target = tab.getAttribute('aria-controls');
      if (target) expect(document.getElementById(target)).not.toBeNull();
    }
    expect(root.querySelector('#tab-a').getAttribute('aria-controls')).toBe('body-a');
  });
});

describe('waveform keyboard announcements', () => {
  it('speaks the playhead through the live region and keeps the help text', async () => {
    vi.useFakeTimers();
    try {
      const { App } = await import('../src/app.js');
      const { installCore } = await import('../src/features/core.js');
      const { AudioFile } = await import('../src/model/audio-file.js');
      const { Channel } = await import('../src/audio/channel.js');
      const { WaveformView } = await import('../src/editor/waveform-view.js');
      HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
      const app = new App();
      installCore(app);
      app.syncGraph = () => {};
      const doc = new AudioFile({ name: 'k.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000))] });
      app.addDocument(doc);
      const view = new WaveformView(app, doc);
      const live = document.createElement('div');
      live.id = 'live-region';
      document.body.replaceChildren(view.el, live);
      view.width = 400;
      const help = view.el.querySelector('#wf-help').textContent;
      view.surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      vi.advanceTimersByTime(400);
      expect(live.textContent).toMatch(/^Playhead /);
      expect(view.el.querySelector('#wf-help').textContent).toBe(help);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('maximize frame', () => {
  it('maximizes the editor frame when no frame has been focused yet, and restores', async () => {
    const { Dock } = await import('../src/ui/dock.js');
    const registry = new Map(['editor', 'files'].map((id) => [id, { id, title: id, create: () => ({ el: document.createElement('div') }) }]));
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dock = new Dock({ openMenu() {} }, root, registry);
    dock.setLayout({ t: 'row', c: [{ t: 'group', tabs: ['files'] }, { t: 'group', tabs: ['editor'] }], s: [1, 3] });
    dock.toggleMaximize();
    expect(dock.maximized).toBe(dock.groupOf('editor'));
    dock.toggleMaximize();
    expect(dock.maximized).toBe(null);
    expect(root.querySelectorAll('.panel-group').length).toBe(2);
  });
});

describe('command labels with menu context', () => {
  it('names submenu commands so they stand on their own', async () => {
    const { App } = await import('../src/app.js');
    const { FEATURES } = await import('../src/features.js');
    const { commandMenuPaths, contextLabel } = await import('../src/ui/menus.js');
    localStorage.clear();
    const app = new App();
    for (const install of FEATURES) install(app);
    const paths = commandMenuPaths();
    const L = (id) => contextLabel(id, app.commands.label(id), paths);
    expect(L('file.import')).toBe('Import > File');
    expect(L('file.exportFile')).toBe('Export > File');
    expect(L('file.exportMarkers')).toBe('Export > Markers');
    expect(L('file.newAudio')).toBe('New > Audio File');
    expect(L('gen.tones')).toBe('Generate > Tones');
    expect(L('theme.dark')).toBe('Theme > Dark');
    expect(L('edit.selectAll')).toBe('Select All');
    expect(L('marker.add')).toBe('Add Cue Marker');
    expect(L('edit.cut')).toBe('Cut');
    expect(L('fx.amplify')).toBe('Amplify');
  });
});

describe('keyboard shortcut editor', () => {
  it('keeps focus on the edited command after capturing a key', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    document.body.replaceChildren();
    const done = app.commands.run('edit.keyboardShortcuts');
    const dialog = document.querySelector('.dialog');
    const search = dialog.querySelector('input[type=search]');
    search.value = 'reverse';
    search.dispatchEvent(new Event('input'));
    const add = dialog.querySelector('.sc-row[data-id="fx.reverse"] .sc-add');
    add.focus();
    add.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
    expect(app.commands.keysFor('fx.reverse')).toEqual(['q']);
    expect(document.activeElement?.dataset.id).toBe('fx.reverse');
    expect(document.activeElement.querySelector('.sc-chip').textContent).toBe('Q');
    dialog.querySelector('.dialog-head .icon-btn').click();
    await done;
  });
});

describe('Convert Sample Type bit depth', () => {
  it('follows undo and redo', async () => {
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const E = await import('../src/model/edits.js');
    const doc = new AudioFile({ name: 'b.wav', sampleRate: 44100, channels: [Channel.fromSamples(new Float32Array(100))], info: { bitDepth: 16 } });
    doc.apply('Convert Sample Type', { ...doc.state, bitDepth: 24 });
    expect(doc.info.bitDepth).toBe(24);
    doc.apply('Reverse', E.reverseRange(doc.state, 0, 50));
    expect(doc.info.bitDepth).toBe(24);
    doc.history.undo();
    doc.history.undo();
    expect(doc.info.bitDepth).toBe(16);
    doc.history.redo();
    expect(doc.info.bitDepth).toBe(24);
  });
});

describe('closing documents', () => {
  it('moves focus to the editor empty state when the last file closes', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { Dock } = await import('../src/ui/dock.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
    localStorage.clear();
    const app = new App();
    installCore(app);
    app.syncGraph = () => {};
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    app.dock = new Dock(app, root, app.panels);
    app.dock.setLayout({ t: 'group', tabs: ['editor'], a: 'editor' });
    const doc = app.addDocument(new AudioFile({ name: 'f.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(10))] }));
    document.body.focus();
    await app.closeDocument(doc);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).not.toBe(document.body);
    expect(root.querySelector('[data-panel="editor"]').contains(document.activeElement)).toBe(true);
  });
});

describe('History panel', () => {
  it('updates rows in place and skips work while hidden', async () => {
    const { App } = await import('../src/app.js');
    const { historyPanel } = await import('../src/panels/history.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const E = await import('../src/model/edits.js');
    localStorage.clear();
    const app = new App();
    app.syncGraph = () => {};
    const doc = app.addDocument(new AudioFile({ name: 'h.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(100))] }));
    const panel = historyPanel(app);
    document.body.replaceChildren(panel.el);
    panel.show();
    doc.apply('Reverse', E.reverseRange(doc.state, 0, 50));
    doc.apply('Invert', E.invertRange(doc.state, 0, 50));
    const items = () => [...panel.el.querySelectorAll('.history-item')];
    const before = items();
    expect(before.map((i) => i.textContent)).toEqual(['Open', 'Reverse', 'Invert']);
    doc.history.undo();
    expect(items()).toEqual(before); // same elements
    expect(before[1].getAttribute('aria-selected')).toBe('true');
    expect(before[2].classList.contains('future')).toBe(true);
    doc.apply('Silence', E.silenceRange(doc.state, 0, 10));
    expect(items().map((i) => i.textContent)).toEqual(['Open', 'Reverse', 'Silence']);
    expect(items()[1]).toBe(before[1]);
    panel.hide();
    doc.apply('Reverse', E.reverseRange(doc.state, 0, 50));
    expect(items()).toHaveLength(3); // not rendered while hidden
    panel.show();
    expect(items()).toHaveLength(4);
    expect(panel.el.querySelector('.panel-footer').textContent).toContain('3 Undo');
    items()[0].click();
    expect(doc.history.index).toBe(0);
  });
});

describe('spectral display commands', () => {
  it('are disabled while a multitrack session is active', async () => {
    const { App } = await import('../src/app.js');
    const { FEATURES } = await import('../src/features.js');
    const { Session } = await import('../src/model/session.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    localStorage.clear();
    const app = new App();
    for (const install of FEATURES) install(app);
    app.syncGraph = () => {};
    const file = app.addDocument(new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(10))] }));
    expect(app.commands.isEnabled('view.spectral')).toBe(true);
    app.addDocument(new Session({ name: 'S.asesx', sampleRate: 48000, tracks: 1 }));
    expect(app.commands.isEnabled('view.spectral')).toBe(false);
    expect(app.commands.isEnabled('view.spectralPitch')).toBe(false);
    app.activate(file);
    expect(app.commands.isEnabled('view.spectralPitch')).toBe(true);
  });
});
