import { describe, it, expect } from 'vitest';
import { envelopeControl } from '../src/effects/editors.js';
import { paramControls } from '../src/effects/param-ui.js';
import { coerce } from '../src/effects/params.js';

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
