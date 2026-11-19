// Number fields scrub like the hot values: drag sideways, click to type.
import { describe, it, expect } from 'vitest';
import { installNumberScrub } from '../src/ui/controls.js';

const at = (type, x, extra = {}) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 0, button: 0, ...extra });
  Object.defineProperty(e, 'pointerType', { value: extra.pointerType || 'mouse' });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
};

describe('number field scrubbing', () => {
  installNumberScrub(document);

  it('drags the value by its step within min and max, then commits', () => {
    document.body.innerHTML = '<input type="number" id="n" value="10" min="0" max="20" step="1">';
    const n = document.getElementById('n');
    const seen = [];
    n.addEventListener('input', () => seen.push(`input ${n.value}`));
    n.addEventListener('change', () => seen.push(`change ${n.value}`));
    n.dispatchEvent(at('pointerdown', 100));
    n.dispatchEvent(at('pointermove', 106));
    expect(n.value).toBe('13');
    n.dispatchEvent(at('pointermove', 200, { shiftKey: true }));
    expect(n.value).toBe('20');
    n.dispatchEvent(at('pointermove', 60));
    expect(n.value).toBe('0');
    n.dispatchEvent(at('pointerup', 60));
    expect(seen.at(-1)).toBe('change 0');
    expect(document.activeElement).not.toBe(n);
  });

  it('a click without dragging focuses the field for typing; touch is left alone', () => {
    document.body.innerHTML = '<input type="number" id="n" value="2.5" step="0.5">';
    const n = document.getElementById('n');
    n.dispatchEvent(at('pointerdown', 50));
    n.dispatchEvent(at('pointerup', 50));
    expect(document.activeElement).toBe(n);
    n.blur();
    n.dispatchEvent(at('pointerdown', 50, { pointerType: 'touch' }));
    n.dispatchEvent(at('pointermove', 90, { pointerType: 'touch' }));
    expect(n.value).toBe('2.5');
  });
});
