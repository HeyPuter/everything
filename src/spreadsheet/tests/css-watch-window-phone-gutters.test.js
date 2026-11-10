import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// The Watch Window floats 24px from the window's right edge and is as wide as the window less 32px, up to 620px. On
// a phone that left it 8px from the left edge and 24px from the right, off centre. Where it spans the window it now
// keeps 16px on each side.
it('leaves the same gutter on both sides when it spans a narrow window', () => {
  const css = stylesheet('chrome.css');
  const px = (v) => Number(/^(\d+)px$/.exec(v)?.[1]);
  const base = declared(css, '.watch-window', false);
  const narrow = declared(css, '.watch-window', 'max-width: 668px');
  expect(base.width).toBe('min(620px, calc(100vw - 32px))');
  for (const vw of [320, 360, 390, 430, 600, 652]) {
    const width = Math.min(620, vw - 32);
    const right = px(narrow.right ?? base.right);
    expect(vw - right - width).toBe(right);
  }
  // A wide window keeps the panel at its corner.
  expect(px(base.right)).toBe(24);
});
