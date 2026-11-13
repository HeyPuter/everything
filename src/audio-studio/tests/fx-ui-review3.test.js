import { describe, it, expect } from 'vitest';
import { paramControls } from '../src/effects/param-ui.js';
import { numberField } from '../src/effects/layout.js';
import { coerce } from '../src/effects/params.js';
import { ratioField, parseClock } from '../src/effects/views/time-pitch.js';
import { beatsField } from '../src/effects/time-units.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { getEffect } from '../src/effects/index.js';
import { Session } from '../src/model/session.js';
import { fakeApp } from './fx-helpers.js';

/** Opens a value field for typing and commits it unchanged; returns the text it offered. */
const commitUnchanged = (el) => {
  el.querySelector('.hot').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  const input = el.querySelector('.hot-edit');
  const text = input.value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return text;
};

describe('value fields opened for typing', () => {
  const cases = [
    [{ id: 'f', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz', scale: 'log' }, 1234],
    [{ id: 'f', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz' }, 12345],
    [{ id: 't', min: 0, max: 5000, step: 1, default: 100, unit: 'ms' }, 1234],
    [{ id: 't', min: 0.1, max: 5000, step: 0.1, default: 100, unit: 'ms', scale: 'log' }, 1234.5],
  ];
  it.each(cases)('keep a %o value that kHz or seconds display rounds (%d)', (p, v) => {
    const def = { id: 'probe', name: 'Probe', params: [{ label: 'Value', ...p }] };
    let values = { [p.id]: v };
    const c = paramControls(
      def,
      () => values,
      (id, x) => {
        values = { ...values, [id]: coerce(def.params[0], x) };
        c.refresh(values, id);
      },
    );
    document.body.append(c.el);
    // Clicking the value and pressing Enter (or clicking away) used to commit "1.23 kHz".
    expect(commitUnchanged(c.el)).toBe(String(v));
    expect(values[p.id]).toBe(v);
    c.el.remove();
  });

  it('keep the value in hand-laid-out dialogs too', () => {
    const p = {
      id: 'f',
      label: 'Frequency',
      min: 20,
      max: 20000,
      step: 1,
      default: 1000,
      unit: 'Hz',
    };
    let values = { f: 1234 };
    const subs = [];
    const ctx = {
      def: { params: [p] },
      get values() {
        return values;
      },
      set: (id, v) => {
        values = { ...values, [id]: coerce(p, v) };
        subs.forEach((fn) => fn(values));
      },
      subscribe: (fn) => subs.push(fn),
    };
    const wrap = document.createElement('div');
    wrap.append(numberField(ctx, 'f'));
    document.body.append(wrap);
    commitUnchanged(wrap);
    expect(values.f).toBe(1234);
    wrap.remove();
  });

  it('still start from the display text when it reads back exactly', () => {
    const p = { id: 'g', label: 'Gain', min: -24, max: 24, step: 0.1, default: 0, unit: 'dB' };
    let values = { g: -3 };
    const c = paramControls(
      { id: 'probe', name: 'Probe', params: [p] },
      () => values,
      (id, x) => {
        values = { ...values, [id]: coerce(p, x) };
        c.refresh(values, id);
      },
    );
    document.body.append(c.el);
    expect(commitUnchanged(c.el)).toBe('-3.0');
    c.el.remove();
    // A value between steps (a delay time restated in beats) offers its display text.
    const q = { id: 'b', label: 'Beats', min: 0, max: 4, step: 0.001, default: 1, unit: 'beats' };
    const d = paramControls(
      { id: 'probe', name: 'Probe', params: [q] },
      () => ({ b: 0.2216667 }),
      () => {},
    );
    document.body.append(d.el);
    expect(commitUnchanged(d.el)).toBe('0.222');
    d.el.remove();
  });
});

describe('custom value fields with a decimal comma', () => {
  const typeInto = (el, text) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = document.querySelector('.hot-edit');
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const ctxFor = (params, initial) => {
    let values = { ...initial };
    const subs = [];
    return {
      def: { params },
      get values() {
        return values;
      },
      set: (id, v) => {
        values = { ...values, [id]: v };
        subs.forEach((fn) => fn(values));
      },
      subscribe: (fn) => subs.push(fn),
    };
  };

  it('read "1,5" as 1.5 in the Pitch Shifter ratio', () => {
    const ctx = ctxFor([], { semitones: 0, cents: 0 });
    const hot = ratioField(ctx);
    document.body.append(hot);
    // The comma was dropped: "1,5" read as 15, limited to a ratio of 4 (+24 semitones).
    typeInto(hot, '1,5');
    expect(ctx.values).toMatchObject({ semitones: 7, cents: 2 });
    hot.remove();
  });

  it('read "1,5" as 1.5 beats in Tempo Sync', () => {
    const p = { id: 'rate', label: 'Rate', min: 0.01, max: 10, default: 1, unit: 'Hz' };
    const ctx = ctxFor([p], { rate: 1 });
    ctx.app = { timeOptions: () => ({ tempo: 120, beatNote: 4 }) };
    const el = beatsField(ctx, 'rate');
    document.body.append(el);
    typeInto(el.querySelector('.hot'), '1,5');
    // 1.5 beats at 120 BPM (500 ms a beat) is one sweep per 750 ms.
    expect(ctx.values.rate).toBeCloseTo(1000 / 750, 6);
    el.remove();
  });

  it('read a decimal comma in typed durations', () => {
    expect(parseClock('0:02,5')).toBe(2.5);
    expect(parseClock('2,5')).toBe(2.5);
    expect(parseClock('1:02.5')).toBe(62.5);
  });
});

describe('effect dialogs for session chains', () => {
  it('preview by playing the session', async () => {
    const app = fakeApp();
    const doc = new Session({ name: 'S', sampleRate: 48000, tracks: 2 });
    doc.setSelection(4800, 9600);
    app.active = doc;
    const plays = [];
    app.play = (o) => plays.push(o);
    // A track's effect slot (rack.js) or track EQ: edit mode, no audio file.
    const p = openEffectDialog(app, getEffect('studioReverb'), {
      mode: 'edit',
      onChange: () => {},
    });
    const dlg = [...document.querySelectorAll('.fx-dialog')].at(-1);
    const play = dlg.querySelector('.fx-play');
    // There was no way to hear the chain: Preview was off and the dialog holds the keyboard.
    expect(play.disabled).toBe(false);
    play.click();
    expect(plays).toEqual([{ from: 4800, loop: true }]);
    expect(play.getAttribute('aria-label')).toBe('Stop preview');
    dlg.querySelector('.dialog-head .icon-btn').click();
    expect(await p).toBeNull();
  });
});
