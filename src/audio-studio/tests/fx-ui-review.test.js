import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envelopeControl, plot } from '../src/effects/editors.js';
import { paramControls } from '../src/effects/param-ui.js';
import { coerce } from '../src/effects/params.js';
import { effectsRackPanel, rackFor } from '../src/effects/rack-panel.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { fakeApp, filled } from './fx-helpers.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { getEffect } from '../src/effects/registry.js';
import { installPreviewEditor } from '../src/editor/preview-editor.js';
import { installFavorites, favoritesPanel, saveFavorites } from '../src/effects/favorites.js';

const pointer = (type, x, y) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

describe('envelope editor', () => {
  it('keeps dragging a point through every pointer move', () => {
    const seen = [];
    const param = { id: 'envelope', label: 'Envelope', min: 0, max: 1, unit: '%' };
    const el = envelopeControl({
      param,
      value: [
        { t: 0, v: 0 },
        { t: 0.5, v: 0.5 },
        { t: 1, v: 1 },
      ],
      onChange: (pts) => seen.push(pts),
    });
    document.body.append(el);
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 112,
      right: 200,
      bottom: 112,
    });
    Object.defineProperty(el, 'clientHeight', { value: 112 });
    const handle = el.querySelectorAll('.fx-point')[1];
    handle.setPointerCapture = () => {};
    handle.dispatchEvent(pointer('pointerdown', 100, 56));
    handle.dispatchEvent(pointer('pointermove', 110, 56));
    // The dragged handle stays in the editor, so later moves still reach it.
    expect(el.querySelectorAll('.fx-point')[1]).toBe(handle);
    handle.dispatchEvent(pointer('pointermove', 150, 56));
    handle.dispatchEvent(pointer('pointerup', 150, 56));
    expect(seen.at(-1)[1].t).toBeCloseTo(0.75, 5);
    expect(handle.style.left).toBe('75%');
    el.remove();
  });
});

describe('log-scaled value fields', () => {
  const def = {
    id: 'logProbe',
    name: 'Log Probe',
    params: [
      {
        id: 'freq',
        label: 'Frequency',
        type: 'number',
        min: 20,
        max: 20000,
        step: 1,
        default: 1000,
        unit: 'Hz',
        scale: 'log',
      },
    ],
  };
  const typeInto = (el, text) => {
    el.querySelector('.hot').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    const input = el.querySelector('.hot-edit');
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  it('keeps a typed value instead of snapping it to a slider position', () => {
    let values = { freq: 1000 };
    const c = paramControls(
      def,
      () => values,
      (id, v) => {
        values = { ...values, [id]: coerce(def.params[0], v) };
        c.refresh(values, id);
      },
    );
    document.body.append(c.el);
    typeInto(c.el, '440');
    expect(values.freq).toBe(440);
    typeInto(c.el, '1.234k');
    expect(values.freq).toBe(1234);
    // Typing the value it already has leaves the display unsnapped.
    typeInto(c.el, '1234');
    expect(c.el.querySelector('.hot').getAttribute('aria-valuetext')).toBe('1.23 kHz');
    typeInto(c.el, '1000');
    expect(values.freq).toBe(1000);
    expect(c.el.querySelector('.hot').getAttribute('aria-valuetext')).toBe('1 kHz');
    // Arrow keys still step the slider position.
    c.el
      .querySelector('.hot')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(values.freq).toBeGreaterThan(1000);
    c.el.remove();
  });
});

describe('value coercion', () => {
  it('keeps every registered parameter inside its range after rounding to its step', async () => {
    const { EFFECTS } = await import('../src/effects/index.js');
    const outside = [];
    for (const d of EFFECTS.values()) {
      for (const p of d.params) {
        if ((p.type || (p.options ? 'choice' : 'number')) !== 'number') continue;
        for (const v of [p.min, p.max, p.min - 1, p.max + 1]) {
          const c = coerce(p, v);
          if (c < p.min || c > p.max) outside.push(`${d.id}.${p.id}: ${v} -> ${c}`);
        }
      }
    }
    expect(outside).toEqual([]);
    expect(coerce({ min: 0.1, max: 500, step: 1 }, 0.1)).toBe(0.1);
  });
});

describe('plots', () => {
  it('stop repainting on theme changes once their dialog has closed', async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const repaints = async () => {
      await frame();
      raf.mockClear();
      window.dispatchEvent(new CustomEvent('themechange'));
      return raf.mock.calls.length;
    };
    const before = await repaints();
    const closed = plot('a', 'A', () => {});
    document.body.append(closed.el);
    closed.redraw();
    await frame();
    closed.el.remove();
    const open = plot('b', 'B', () => {});
    document.body.append(open.el);
    // Only the plot on the page schedules a repaint.
    expect(await repaints()).toBe(before + 1);
    raf.mockRestore();
    open.el.remove();
  });
});

describe('Effects Rack levels', () => {
  it('accept typed values with units and ignore empty entries', () => {
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(filled(480, 0.1))],
    });
    app.active = doc;
    const panel = effectsRackPanel(app);
    document.body.append(panel.el);
    const type = (i, text) => {
      const hot = panel.el.querySelectorAll('.rack-knob .hot')[i];
      hot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const input = panel.el.querySelector('.hot-edit');
      input.value = text;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    type(0, '-6 dB');
    expect(rackFor(doc).input).toBe(-6);
    type(0, '+3');
    expect(rackFor(doc).input).toBe(3);
    type(0, '1,5');
    expect(rackFor(doc).input).toBe(1.5);
    type(0, '');
    expect(rackFor(doc).input).toBe(1.5);
    type(1, '-2.5dB');
    expect(rackFor(doc).output).toBe(-2.5);
    type(2, '40%');
    expect(rackFor(doc).mix).toBeCloseTo(0.4);
    type(2, ' ');
    expect(rackFor(doc).mix).toBeCloseTo(0.4);
    panel.el.remove();
  });
});

describe('effect dialog favorites', () => {
  it('asks for a name instead of saving a favorite without one', async () => {
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(filled(480, 0.1))],
    });
    app.active = doc;
    const saved = [];
    app.favorites = { addEffect: (name) => saved.push(name) };
    const done = openEffectDialog(app, getEffect('amplify'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    dlg.querySelector('[aria-label="Save settings as a favorite"]').click();
    const bar = dlg.querySelector('.fx-namebar');
    const input = bar.querySelector('input');
    input.value = '   ';
    [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    expect(saved).toEqual([]);
    expect(bar.querySelector('.fx-name-error').textContent).toBe('Enter a favorite name.');
    input.value = ' Louder ';
    [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    expect(saved).toEqual(['Louder']);
    expect(bar.hidden).toBe(true);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    expect(await done).toBe(null);
  });
});

describe('Preview Editor', () => {
  it('appears on its own once an offline effect changes the length', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    const app = fakeApp();
    app.formatTime = (f, rate) => `${(f / rate).toFixed(3)}`;
    const host = document.createElement('div');
    document.body.append(host);
    installPreviewEditor(app, host);
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 1000,
      channels: [Channel.fromSamples(filled(1000, 0.1))],
    });
    doc.view = { start: 0, end: 1000, amp: 1 };
    const ran = [];
    const stretch = {
      id: 'pvStretch',
      name: 'Stretch',
      params: [{ id: 'k', min: 1, max: 2, default: 1 }],
      kind: null,
      process: async ({ channels, values }) => {
        ran.push('stretch');
        return channels.map((c) => new Float32Array(Math.round(c.length * values.k)));
      },
    };
    const gain = {
      id: 'pvGain',
      name: 'Gain',
      params: [{ id: 'g', min: 0, max: 2, default: 1 }],
      kind: 3,
      process: async ({ channels }) => {
        ran.push('gain');
        return channels;
      },
    };
    const el = host.querySelector('.preview-editor');
    const settle = () => new Promise((r) => setTimeout(r, 300));
    // A realtime effect never changes the length: nothing renders while the preview is hidden.
    app.emit('effect-values', { def: gain, values: { g: 2 }, doc });
    await settle();
    expect(ran).toEqual([]);
    expect(el.hidden).toBe(true);
    // An offline effect that keeps the length leaves it hidden; one that changes it shows it.
    app.emit('effect-values', { def: stretch, values: { k: 1 }, doc });
    await settle();
    expect(ran).toEqual(['stretch']);
    expect(el.hidden).toBe(true);
    app.emit('effect-values', { def: stretch, values: { k: 1.5 }, doc });
    await settle();
    expect(el.hidden).toBe(false);
    expect(host.querySelector('.preview-status').textContent).toBe('Length +0.500');
    app.emit('effect-values', null);
    expect(el.hidden).toBe(true);
    host.remove();
  });
});

describe('effect dialog preview', () => {
  it('keeps previewing through the effect when the loop button is toggled', async () => {
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(filled(4800, 0.1))],
    });
    app.active = doc;
    let playing = false;
    app.play = () => {
      playing = true;
      app.emit('transport', 'playing');
    };
    app.stop = () => {
      if (!playing) return;
      playing = false;
      app.emit('transport', 'stopped');
    };
    const done = openEffectDialog(app, getEffect('amplify'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    const play = dlg.querySelector('.fx-play');
    play.click();
    expect(playing).toBe(true);
    expect(app.previewFx?.[0]?.key).toBe('preview:amplify');
    dlg.querySelector('.fx-loop').click();
    // Playback restarted with the new loop setting, still through the effect.
    expect(playing).toBe(true);
    expect(app.previewFx?.[0]?.key).toBe('preview:amplify');
    expect(play.getAttribute('aria-label')).toBe('Stop preview');
    play.click();
    expect(playing).toBe(false);
    expect(app.previewFx).toBe(null);
    expect(play.getAttribute('aria-label')).toBe('Preview');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    await done;
  });
});

describe('effect view layouts', () => {
  it('stack the Center Channel Extractor and Automatic Pitch Correction columns on narrow screens', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/effects-content.css'), 'utf8');
    for (const name of ['cce-split', 'apc-split']) {
      const wide = css.indexOf(`.fx-split.${name} {`);
      expect(wide).toBeGreaterThan(-1);
      // A later narrow-screen rule (same specificity) takes the view down to one column.
      const narrow = css
        .slice(wide)
        .match(
          new RegExp(
            `@media \\(max-width: 720px\\) \\{[^@]*\\.fx-split\\.${name}[^{]*\\{\\s*grid-template-columns: minmax\\(0, 1fr\\);`,
          ),
        );
      expect(narrow, name).not.toBe(null);
    }
  });

  it('wrap columns of sliders onto a second row on tablets', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/effects.css'), 'utf8');
    const base = css.indexOf('.fx-columns {');
    const tablet = css.indexOf('@media (max-width: 1100px)', base);
    const phone = css.indexOf('@media (max-width: 720px)', base);
    // The tablet rule follows the base rule and comes before the one-column phone rule.
    expect(base).toBeGreaterThan(-1);
    expect(tablet).toBeGreaterThan(base);
    expect(phone).toBeGreaterThan(tablet);
    expect(css.slice(tablet, phone)).toMatch(
      /\.fx-columns:has\(\.fx-scale\) \{\s*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 280px\), 1fr\)\);/,
    );
  });

  it('scroll the Generate Tones components inside their frame on narrow screens', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/effects-content.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (max-width: 760px)')).split(/\n}\n/)[0];
    // The frame may shrink to the dialog's width (it is sized to its content otherwise).
    expect(block).toMatch(
      /\.gen-columns > \.fx-group:has\(\.gen-comps\) \{\s*flex: 1 1 100%;\s*min-width: 0;/,
    );
    expect(block).toMatch(/\.gen-comps \{\s*overflow-x: auto;/);
  });
});

describe('Favorites panel', () => {
  it('redraws on selection changes only when they change what a favorite can do', () => {
    const app = fakeApp();
    installFavorites(app);
    app.commands.register({
      id: 'test.needsSel',
      label: 'Needs Selection',
      enabled: (a) => Boolean(a.active?.hasSelection),
      run: () => {},
    });
    saveFavorites(app.prefs, [
      {
        id: 'f1',
        name: 'Needs Selection',
        shortcut: '',
        action: { type: 'command', command: 'test.needsSel' },
      },
    ]);
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 1000,
      channels: [Channel.fromSamples(filled(1000, 0.1))],
    });
    doc.on('change', (e) => app.emit('doc-change', doc, e));
    app.active = doc;
    const panel = favoritesPanel(app);
    document.body.append(panel.el);
    const row = () => panel.el.querySelector('tbody tr');
    const first = row();
    expect(first.title).toMatch(/Not available/);
    doc.setSelection(100, 200);
    const second = row();
    expect(second).not.toBe(first);
    expect(second.title).not.toMatch(/Not available/);
    // Moving the selection changes nothing for the favorite: the rows stay as they are.
    doc.setSelection(100, 300);
    doc.setSelection(150, 400);
    expect(row()).toBe(second);
    panel.el.remove();
  });
});

describe('Multiband Compressor crossovers', () => {
  it('stay in order, as the processor keeps them', async () => {
    await import('../src/effects/index.js');
    await import('../src/effects/views/index.js');
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(filled(480, 0.1))],
    });
    app.active = doc;
    let latest = null;
    const done = openEffectDialog(app, getEffect('multibandCompressor'), {
      doc,
      mode: 'edit',
      values: {},
      onChange: (v) => (latest = v),
    });
    const dlg = document.querySelector('.fx-dialog');
    const low = dlg.querySelector('[aria-label="Low crossover"]');
    for (let i = 0; i < 40; i++)
      low.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
    expect(latest.xover1).toBeLessThan(latest.xover2);
    const high = dlg.querySelector('[aria-label="High crossover"]');
    for (let i = 0; i < 40; i++)
      high.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }),
      );
    expect(latest.xover3).toBeGreaterThan(latest.xover2);
    // Typing a crossover past its neighbour stops at the neighbour too.
    const midHot = [...dlg.querySelectorAll('.fx-mb-xovers .hot')][1];
    midHot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = dlg.querySelector('.fx-mb-xovers .hot-edit');
    input.value = '50';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(latest.xover2).toBeGreaterThan(latest.xover1);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    await done;
  });
});
