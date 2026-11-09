// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LayerManager } from '../src/ui/layers.js';

function manager() {
  const lm = new LayerManager({});
  const calls = [];
  lm.newLayer = () => calls.push('new');
  lm.makeCurrent = () => calls.push('current');
  document.body.append(lm.el);
  return { lm, calls };
}
const press = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, altKey: true, ...init }));

describe('layer manager shortcuts', () => {
  it('work with Alt+N and Alt+C', () => {
    const { lm, calls } = manager();
    press(lm.el, { key: 'n', code: 'KeyN' });
    press(lm.el, { key: 'C', code: 'KeyC' });
    expect(calls).toEqual(['new', 'current']);
    lm.el.remove();
  });
  it('work with Option+N and Option+C on macOS', () => {
    const { lm, calls } = manager();
    press(lm.el, { key: 'Dead', code: 'KeyN' });
    press(lm.el, { key: 'ç', code: 'KeyC' });
    expect(calls).toEqual(['new', 'current']);
    lm.el.remove();
  });
  it('leave characters typed with Option in text fields alone', () => {
    const { lm, calls } = manager();
    const inp = document.createElement('input');
    lm.el.append(inp);
    expect(press(inp, { key: 'ç', code: 'KeyC' })).toBe(true);
    expect(calls).toEqual([]);
    lm.el.remove();
  });
});
