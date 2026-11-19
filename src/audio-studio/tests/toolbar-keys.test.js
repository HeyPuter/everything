// Panel toolbars (Transport, Zoom, Tools): one tab stop, arrow keys move
// between enabled buttons, related buttons grouped so they wrap together.
import { describe, it, expect, beforeAll } from 'vitest';
import { toolbarKeys } from '../src/panels/toolbar-keys.js';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

describe('toolbarKeys', () => {
  it('keeps one tab stop and moves with the arrow keys, skipping disabled buttons', () => {
    const root = document.createElement('div');
    root.setAttribute('role', 'toolbar');
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => Object.assign(document.createElement('button'), { textContent: t }));
    c.disabled = true;
    root.append(a, b, c, d);
    document.body.append(root);
    const keys = toolbarKeys(root);
    expect([a, b, c, d].map((x) => x.tabIndex)).toEqual([0, -1, -1, -1]);
    a.focus();
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowRight');
    expect(document.activeElement).toBe(b);
    key('ArrowRight');
    expect(document.activeElement).toBe(d);
    expect(d.tabIndex).toBe(0);
    expect(a.tabIndex).toBe(-1);
    key('Home');
    expect(document.activeElement).toBe(a);
    key('ArrowLeft');
    expect(document.activeElement).toBe(d);
    // The tab stop moves off a button that becomes disabled.
    d.focus();
    d.disabled = true;
    keys.sync();
    expect(a.tabIndex).toBe(0);
    root.remove();
  });
});

describe('panel toolbars', () => {
  it('group the Transport and Zoom buttons into clusters with one tab stop each toolbar', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installPanelsExtra } = await import('../src/features/panels-extra.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    installPanelsExtra(app);
    app.syncGraph = () => {};
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    app.addDocument(new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(1000))] }));
    const transport = app.panels.get('transport').create(app);
    const groups = [...transport.el.querySelectorAll('.button-cluster')].map((g) => g.querySelectorAll('button').length);
    expect(groups).toEqual([3, 4, 3]);
    transport.render();
    expect(transport.el.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    const zoom = app.panels.get('zoom').create(app);
    expect(zoom.el.querySelectorAll('.button-cluster').length).toBe(5);
    zoom.render();
    expect(zoom.el.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    const tools = app.panels.get('tools').create(app);
    tools.render();
    expect(tools.el.querySelectorAll('[role=toolbar] button[tabindex="0"]')).toHaveLength(1);
  });
});

describe('panel toolbars are labelled toolbars with one tab stop', () => {
  it('Files, Markers and Playlist', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installPanelsExtra } = await import('../src/features/panels-extra.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    installPanelsExtra(app);
    app.syncGraph = () => {};
    app.addDocument(new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(1000))] }));
    for (const [id, label] of [['files', 'Files'], ['markers', 'Markers'], ['playlist', 'Playlist']]) {
      const panel = app.panels.get(id).create(app);
      panel.show?.();
      const bar = panel.el.querySelector('[role=toolbar]');
      expect(bar.getAttribute('aria-label')).toBe(label);
      expect(bar.querySelectorAll('button[tabindex="0"]').length).toBeLessThanOrEqual(1);
    }
    const sel = app.panels.get('selection').create(app);
    expect(sel.el.querySelector('table').getAttribute('aria-label')).toBe('Selection and view ranges');
  });
});
