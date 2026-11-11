import { describe, it, expect, vi } from 'vitest';
import { envelopeControl, plot } from '../src/effects/editors.js';
import { paramControls } from '../src/effects/param-ui.js';
import { coerce } from '../src/effects/params.js';
import { effectsRackPanel, rackFor } from '../src/effects/rack-panel.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { fakeApp, filled } from './fx-helpers.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { getEffect } from '../src/effects/registry.js';

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
