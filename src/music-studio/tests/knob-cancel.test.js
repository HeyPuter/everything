import { expect, it, vi } from 'vitest';
import { createKnob } from '../src/ui/knob.js';

it('preserves another knob readout when an inactive control is canceled', () => {
  vi.useFakeTimers();
  const param = { id: 'gain', min: 0, max: 1, def: 0.5 };
  const idle = createKnob({ param, value: 0.5 });
  const onEnd = vi.fn();
  const editing = createKnob({ param, value: 0.5, onEnd });
  document.body.append(idle.el, editing.el);
  try {
    editing.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const readout = document.querySelector('.param-readout');
    expect(readout.hidden).toBe(false);
    idle.cancel();
    expect(readout.hidden).toBe(false);
    editing.cancel();
    expect(readout.hidden).toBe(true);
    vi.advanceTimersByTime(500);
    expect(onEnd).not.toHaveBeenCalled();
  } finally {
    idle.cancel();
    editing.cancel();
    vi.useRealTimers();
    document.body.replaceChildren();
  }
});
