// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { el, append, debounce, clamp, formatBytes, relativeTime, fieldId, scrollBehavior, shortcutCode } from '../src/ui/dom.js';

describe('el', () => {
  it('builds elements from a tag.class spec with attributes, listeners, and children', () => {
    const clicks = [];
    const node = el('button.btn.btn-primary', { type: 'button', 'aria-label': 'Go', dataset: { id: '7' }, onclick: () => clicks.push(1), style: { color: 'red' } }, 'Hi', null, false, 0, ['a', el('span', {}, 'b')]);
    expect(node.tagName).toBe('BUTTON');
    expect(node.className).toBe('btn btn-primary');
    expect(node.getAttribute('aria-label')).toBe('Go');
    expect(node.dataset.id).toBe('7');
    expect(node.style.color).toBe('red');
    expect(node.textContent).toBe('Hiab');
    node.click();
    expect(clicks).toEqual([1]);
  });

  it('sets innerHTML through html and boolean attributes as empty strings', () => {
    const node = el('div', { html: '<i>x</i>', hidden: true });
    expect(node.innerHTML).toBe('<i>x</i>');
    expect(node.hidden).toBe(true);
  });

  it('explicitly disables browser defaults such as spellcheck and dragging', () => {
    const field = el('input', { spellcheck: false, 'aria-invalid': false, disabled: false });
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(field.disabled).toBe(false);
    expect(el('img', { draggable: false }).draggable).toBe(false);
  });

  it('drops falsy children so conditional rendering is safe', () => {
    const node = append(document.createElement('div'), [undefined, '', 0, 'ok']);
    expect(node.textContent).toBe('ok');
  });
});

describe('utilities', () => {
  it('debounces with flush and cancel', () => {
    vi.useFakeTimers();
    const calls = [];
    const d = debounce((x) => calls.push(x), 100);
    d(1); d(2);
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([]);
    d.flush();
    expect(calls).toEqual([2]);
    d(3);
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([2]);
    vi.useRealTimers();
  });

  it('clamps, formats bytes, and produces unique ids', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fieldId('x')).not.toBe(fieldId('x'));
  });

  it('describes relative times and accepts unix seconds', () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    expect(relativeTime(now - 10 * 1000, now)).toBe('Just now');
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe('5 min ago');
    expect(relativeTime(now - 2 * 3600 * 1000, now)).toBe('2 hours ago');
    expect(relativeTime((now - 3 * 86400 * 1000) / 1000, now)).toBe('3 days ago');
    expect(relativeTime(0, now)).toBe('');
  });
});

describe('scrollBehavior', () => {
  it('scrolls smoothly unless the user asked for reduced motion', () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('reduced-motion') }));
    expect(scrollBehavior()).toBe('auto');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(scrollBehavior()).toBe('smooth');
    vi.unstubAllGlobals();
  });
});

describe('shortcutCode', () => {
  it('names a letter chord by the letter the layout types', () => {
    expect(shortcutCode({ key: 'z', code: 'KeyY', ctrlKey: true })).toBe('KeyZ');
    expect(shortcutCode({ key: 'A', code: 'KeyQ', shiftKey: true })).toBe('KeyA');
    expect(shortcutCode({ key: 'b', code: 'KeyN' })).toBe('KeyB');
  });
  it('keeps the physical key for other scripts, Option and keys that type no letter', () => {
    expect(shortcutCode({ key: 'ы', code: 'KeyS' })).toBe('KeyS');
    expect(shortcutCode({ key: 'å', code: 'KeyA', altKey: true })).toBe('KeyA');
    expect(shortcutCode({ key: '&', code: 'Digit1' })).toBe('Digit1');
    expect(shortcutCode({ key: '.', code: 'Period' })).toBe('Period');
    expect(shortcutCode({ key: 'F4', code: 'F4' })).toBe('F4');
    expect(shortcutCode({ key: "'", code: 'KeyQ' })).toBe('');
  });
});
