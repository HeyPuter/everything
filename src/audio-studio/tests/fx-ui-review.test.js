import { describe, it, expect } from 'vitest';
import { envelopeControl } from '../src/effects/editors.js';

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
