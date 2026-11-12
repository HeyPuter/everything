import { describe, it, expect } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, registerEffect, slotSpec } from '../src/effects/registry.js';
import { openEffectDialog, paramControls } from '../src/effects/dialog.js';
import { scaleTicks, formatParts } from '../src/effects/params.js';
import { routeSummary, routeMask, routeInputs, routeOutputs, defaultRoute } from '../src/effects/routing.js';
import { renderEffect } from '../src/effects/apply.js';
import { FxHost } from '../src/engine/fxhost.js';
import { fakeApp, filled } from './fx-helpers.js';

registerEffect({
  id: 'chromeTest',
  name: 'Chrome Test',
  group: 'Special',
  kind: null,
  layout: { columns: [['Left'], ['Right']], collapsed: ['More'], vertical: ['Bands'] },
  params: [
    { id: 'mode', label: 'Mode', type: 'choice', options: [{ value: 0, label: 'Soft' }, { value: 1, label: 'Hard' }], default: 0 },
    { id: 'shape', label: 'Shape', type: 'choice', options: ['A', 'B', 'C', 'D'].map((l, i) => ({ value: i, label: l })), default: 0 },
    { id: 'lOn', label: 'Left', type: 'bool', default: true, section: 'Left' },
    { id: 'lGain', label: 'Gain', min: -24, max: 24, step: 0.1, default: 0, unit: 'dB', section: 'Left' },
    { id: 'rGain', label: 'Gain', min: -24, max: 24, step: 0.1, default: 0, unit: 'dB', section: 'Right', enabledIf: (v) => v.mode === 1 },
    { id: 'extra', label: 'Extra', min: 0, max: 100, step: 1, default: 50, unit: '%', section: 'More', ends: ['Dry', 'Wet'] },
    { id: 'b1', label: '100 Hz', short: '100', min: -12, max: 12, step: 0.1, default: 0, unit: 'dB', section: 'Bands' },
    { id: 'b2', label: '1 kHz', short: '1k', min: -12, max: 12, step: 0.1, default: 0, unit: 'dB', section: 'Bands' },
  ],
  process: async ({ channels }) => channels.map((c) => c.map((x) => x * 2)),
});

registerEffect({
  id: 'chromeTabs',
  name: 'Chrome Tabs',
  group: 'Special',
  kind: null,
  layout: { tabs: [{ label: 'Main', sections: [null] }, { label: 'Settings', sections: ['Detector'] }] },
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
    { id: 'attack', label: 'Attack', min: 1, max: 100, step: 1, default: 10, unit: 'ms', section: 'Detector' },
  ],
  process: async ({ channels }) => channels,
});

const stereoDoc = (n = 480) => new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(n, 0.25)), Channel.fromSamples(filled(n, -0.5))] });

function setup(doc = stereoDoc()) {
  const app = fakeApp();
  app.active = doc;
  return { app, doc };
}

const close = (dlg) => dlg.querySelector('.dialog-head .icon-btn').click();

describe('slider scales', () => {
  it('labels both ends of linear ranges on round steps', () => {
    const labels = (p) => scaleTicks(p).major.map((t) => t.label);
    expect(labels({ min: -100, max: 0 })).toEqual(['-100', '-80', '-60', '-40', '-20', '0']);
    expect(labels({ min: -180, max: 180 })).toEqual(['-180', '-120', '-60', '0', '60', '120', '180']);
    expect(labels({ min: -24, max: 24 })).toEqual(['-24', '-12', '0', '12', '24']);
    const t = scaleTicks({ min: 0, max: 100 });
    expect(t.major[0].x).toBe(0);
    expect(t.major.at(-1).x).toBe(1);
    expect(t.minor.length).toBe(5);
  });

  it('labels 1-2-5 values on log ranges and thins them when crowded', () => {
    const t = scaleTicks({ min: 20, max: 20000, scale: 'log', unit: 'Hz' });
    expect(t.major.map((m) => m.label)).toEqual(['20', '100', '200', '1k', '2k', '10k', '20k']);
    expect(t.major.every((m) => m.x >= 0 && m.x <= 1)).toBe(true);
    expect(scaleTicks({ min: 0.1, max: 10, scale: 'log' }).major.map((m) => m.label)).toEqual(['0.1', '0.2', '0.5', '1', '2', '5', '10']);
  });

  it('splits values into number and unit', () => {
    expect(formatParts({ unit: 'dB', step: 0.1 }, -3)).toEqual(['-3.0', 'dB']);
    expect(formatParts({ unit: 'Hz', step: 1 }, 2500)).toEqual(['2.5', 'kHz']);
    expect(formatParts({ unit: ':1', step: 0.1 }, 4)).toEqual(['4.0', ':1']);
    expect(formatParts({ type: 'bool' }, true)).toEqual(['On', '']);
  });
});

describe('generated controls', () => {
  it('frames sections, arranges columns, collapses and draws vertical sliders', () => {
    let values = { mode: 0, shape: 0, lOn: true, lGain: 0, rGain: 0, extra: 50, b1: 0, b2: 0 };
    const set = [];
    const c = paramControls(getEffect('chromeTest'), () => values, (id, v) => set.push([id, v]));
    const el = c.el;
    expect([...el.querySelectorAll('.fx-column')].map((col) => col.querySelector('.fx-group').dataset.section)).toEqual(['Left', 'Right']);
    // Two short options become radio buttons; four stay a dropdown.
    expect(el.querySelectorAll('.fx-radios input[type=radio]')).toHaveLength(2);
    expect(el.querySelectorAll('select')).toHaveLength(1);
    // The section's own switch sits in its frame title.
    const legendBox = el.querySelector('[data-section="Left"] > legend input[type=checkbox]');
    expect(legendBox.checked).toBe(true);
    legendBox.checked = false;
    legendBox.dispatchEvent(new Event('change'));
    expect(set.at(-1)).toEqual(['lOn', false]);
    values = { ...values, lOn: false };
    c.refresh(values);
    expect(el.querySelector('[data-section="Left"]').classList.contains('off')).toBe(true);
    // enabledIf greys out a control until it matters.
    const right = el.querySelector('[data-section="Right"] input[type=range]');
    expect(right.disabled).toBe(true);
    values = { ...values, mode: 1 };
    c.refresh(values);
    expect(right.disabled).toBe(false);
    expect(el.querySelector('details[data-section="More"]').open).toBe(false);
    expect([...el.querySelectorAll('details .fx-ends span')].map((s) => s.textContent)).toEqual(['Dry', 'Wet']);
    const vs = el.querySelectorAll('[data-section="Bands"] .fx-vslider');
    expect([...vs].map((v) => v.querySelector('.fx-vlabel').textContent)).toEqual(['100', '1k']);
    expect(vs[0].querySelector('input[type=range]').getAttribute('aria-orientation')).toBe('vertical');
  });

  it('draws tick labels above sliders, shows units apart, and resets on double-click', () => {
    let values = { left: -6, right: -6, linked: true };
    const seen = [];
    const c = paramControls(getEffect('amplify'), () => values, (id, v) => seen.push([id, v]));
    const labels = [...c.el.querySelector('.fx-scale').querySelectorAll('.fx-tick-label')].map((t) => t.textContent);
    expect(labels.length).toBeGreaterThanOrEqual(4);
    const hot = c.el.querySelector('.hot');
    expect(hot.querySelector('.hot-num').textContent).toBe('-6.0');
    expect(hot.querySelector('.hot-unit').textContent).toBe('dB');
    c.el.querySelector('input[type=range]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(seen.at(-1)).toEqual(['left', 0]);
  });
});

describe('dialog chrome', () => {
  it('has presets, favorite, channel map and info buttons and an In/Out summary', async () => {
    const { app, doc } = setup();
    app.favorites = { addEffect: () => {} };
    const p = openEffectDialog(app, getEffect('amplify'), { doc, routing: {} });
    const dlg = document.querySelector('.fx-dialog');
    const bar = dlg.querySelector('.fx-presetbar');
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Save settings as a preset', 'Delete preset', 'Save settings as a favorite', 'Channel map', 'About this effect']);
    expect(dlg.querySelector('.fx-route-summary').textContent).toBe('In: L, R | Out: L, R');
    const info = dlg.querySelector('.fx-info');
    expect(info.hidden).toBe(true);
    dlg.querySelector('.fx-info-btn').click();
    expect(info.hidden).toBe(false);
    expect(info.textContent).toMatch(/double-click/i);
    close(dlg);
    expect(await p).toBeNull();
  });

  it('closes an open channel map or info popover on Escape before the dialog', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('amplify'), { doc, routing: {} });
    const dlg = document.querySelector('.fx-dialog');
    const esc = (target) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    for (const sel of ['.fx-map-btn', '.fx-info-btn']) {
      const btn = dlg.querySelector(sel);
      btn.click();
      const panel = dlg.querySelector(sel === '.fx-map-btn' ? '.fx-chmap' : '.fx-info');
      expect(panel.hidden).toBe(false);
      esc(panel.querySelector('select') || btn);
      expect(panel.hidden).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(btn);
      expect(dlg.isConnected).toBe(true);
    }
    // With nothing open, Escape closes the dialog.
    esc(dlg.querySelector('.fx-map-btn'));
    expect(await p).toBeNull();
    expect(dlg.isConnected).toBe(false);
  });

  it('routes channels from the channel map into the preview slot and the result', async () => {
    const { app, doc } = setup();
    const routing = {};
    const p = openEffectDialog(app, getEffect('amplify'), { doc, routing });
    const dlg = document.querySelector('.fx-dialog');
    dlg.querySelector('.fx-map-btn').click();
    const selects = dlg.querySelectorAll('.fx-chmap select');
    expect(selects).toHaveLength(4);
    // Both effect inputs read the left channel; the right file channel stays unprocessed.
    selects[1].value = '0';
    selects[1].dispatchEvent(new Event('change'));
    selects[3].value = '-1';
    selects[3].dispatchEvent(new Event('change'));
    expect(dlg.querySelector('.fx-route-summary').textContent).toBe('In: L, L | Out: L');
    dlg.querySelector('.fx-play').click();
    expect(app.previewFx[0].route).toEqual({ in: [0, 0], out: [0, -1] });
    dlg.querySelector('.btn.primary').click();
    await p;
    expect(routing.route).toEqual({ in: [0, 0], out: [0, -1] });
    // Reopening the dialog keeps the map.
    const routing2 = {};
    const p2 = openEffectDialog(app, getEffect('amplify'), { doc, routing: routing2 });
    expect(document.querySelector('.fx-route-summary').textContent).toBe('In: L, L | Out: L');
    close(document.querySelector('.fx-dialog'));
    await p2;
  });

  it('starts from the editor channel enables and disables the map for mono files', async () => {
    const { app, doc } = setup();
    doc.selection = { ...doc.selection, channels: [true, false] };
    const p = openEffectDialog(app, getEffect('chromeTabs'), { doc, routing: {} });
    expect(document.querySelector('.fx-route-summary').textContent).toBe('In: L, R | Out: L');
    close(document.querySelector('.fx-dialog'));
    await p;
    const mono = new AudioFile({ name: 'm.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(100, 0.1))] });
    const p2 = openEffectDialog(app, getEffect('amplify'), { doc: mono, routing: {} });
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg.querySelector('.fx-map-btn').disabled).toBe(true);
    expect(dlg.querySelector('.fx-route-summary').textContent).toBe('In: M | Out: M');
    close(dlg);
    await p2;
  });

  it('shows tabbed pages', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('chromeTabs'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    const tabs = dlg.querySelectorAll('[role=tab]');
    expect([...tabs].map((t) => t.textContent)).toEqual(['Main', 'Settings']);
    const pages = dlg.querySelectorAll('[role=tabpanel]');
    expect(pages[1].hidden).toBe(true);
    tabs[1].click();
    expect(pages[0].hidden).toBe(true);
    expect(pages[1].hidden).toBe(false);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(pages[1].querySelector('[data-section="Detector"]')).not.toBeNull();
    close(dlg);
    await p;
  });
});

describe('channel routes', () => {
  it('summarises, masks and maps channels', () => {
    expect(routeSummary(null, 2)).toBe('In: L, R | Out: L, R');
    expect(routeSummary({ in: [1, -1], out: [-1, 0] }, 2)).toBe('In: R, - | Out: R');
    expect(defaultRoute([true, false])).toEqual({ in: [0, 1], out: [0, -1] });
    expect(routeMask({ in: [0, 1], out: [0, -1] }, 2)).toEqual([true, false]);
    expect(routeMask({ in: [0, 1], out: [0, 1] }, 2, [true, false])).toBeNull();
    const L = filled(3, 1);
    const R = filled(3, 2);
    expect(routeInputs([L, R], { in: [1, -1], out: [0, 1] }).map((c) => [...c])).toEqual([[2, 2, 2], [0, 0, 0]]);
    expect(routeOutputs([filled(3, 5), filled(3, 6)], [L, R], { in: [0, 1], out: [1, -1] }).map((c) => [...c])).toEqual([[6, 6, 6], [2, 2, 2]]);
  });

  it('routes offline processes', async () => {
    const doc = stereoDoc(4);
    const route = { in: [1, 0], out: [0, -1] };
    const { state } = await renderEffect({ def: getEffect('chromeTest'), values: {}, state: doc.state, start: 0, end: 4, route });
    expect([...state.channels[0].toArray()]).toEqual([-1, -1, -1, -1]);
    expect([...state.channels[1].toArray()]).toEqual([-0.5, -0.5, -0.5, -0.5]);
  });

  it('routes realtime slots in FxHost (preview and apply share it)', () => {
    const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), 48000);
    const def = getEffect('amplify');
    const run = (route) => {
      const spec = slotSpec(def, { left: 20 * Math.log10(2), right: 20 * Math.log10(2), linked: true }, { key: `amp${JSON.stringify(route)}`, route });
      const chain = host.sync([spec]);
      const buf = [filled(256, 0.25), filled(256, -0.5)];
      host.run(chain, buf, 256);
      return [buf[0][255], buf[1][255]];
    };
    expect(run(null).map((v) => Number(v.toFixed(3)))).toEqual([0.5, -1]);
    // Right input from left, left output unprocessed.
    expect(run({ in: [0, 0], out: [-1, 1] }).map((v) => Number(v.toFixed(3)))).toEqual([0.25, 0.5]);
    // Outputs swapped.
    expect(run({ in: [0, 1], out: [1, 0] }).map((v) => Number(v.toFixed(3)))).toEqual([-1, 0.5]);
  });
});
