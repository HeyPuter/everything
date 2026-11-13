import { describe, it, expect } from 'vitest';
import { paramControls } from '../src/effects/param-ui.js';
import { numberField } from '../src/effects/layout.js';
import { coerce } from '../src/effects/params.js';

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
