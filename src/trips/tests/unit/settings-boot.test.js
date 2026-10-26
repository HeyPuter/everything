import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import textScale, { scaleFontSizes } from '../../tools/vite-text-scale.mjs';

for (const entry of ['index.html', 'mock.html']) {
  const html = readFileSync(resolve(entry), 'utf8');
  const boot = (appearance) => new JSDOM(html, {
    url: 'https://trips.puter.com/', runScripts: 'dangerously',
    beforeParse(window) { if (appearance !== undefined) window.localStorage.setItem('trips:appearance', appearance); },
  });
  describe(`${entry} appearance before paint`, () => {
    it('restores text size, contrast and motion', () => {
      const dom = boot(JSON.stringify({ textSize: 1.3, contrast: 'more', motion: 'reduce' }));
      const root = dom.window.document.documentElement;
      expect(root.style.getPropertyValue('--text-scale')).toBe('1.3');
      expect(root.dataset.contrast).toBe('more');
      expect(root.dataset.motion).toBe('reduce');
      dom.window.close();
    });
    it.each([null, '', '{', '"x"', JSON.stringify({ textSize: 9, contrast: 'loud', motion: 'fast' }), JSON.stringify({ textSize: 1 }), JSON.stringify({ textSize: '1.2;color:red' })])(
      'ignores %s', (value) => {
        const dom = boot(value ?? undefined);
        const root = dom.window.document.documentElement;
        expect(root.style.getPropertyValue('--text-scale')).toBe('');
        expect(root.hasAttribute('data-contrast')).toBe(false);
        expect(root.hasAttribute('data-motion')).toBe(false);
        dom.window.close();
      });
  });
}

describe('text-scale build transform', () => {
  it('scales px font sizes and leaves everything else', () => {
    expect(scaleFontSizes('.a { font-size: 14px; } html { font: 15px/1.45 var(--font); } .b{font-size:12.5px}'))
      .toBe('.a { font-size: calc(14px * var(--text-scale, 1)); } html { font: calc(15px * var(--text-scale, 1))/1.45 var(--font); } .b{font-size:calc(12.5px * var(--text-scale, 1))}');
    const untouched = ':root { --font: system-ui; --font-size: 14px; } input { font-size: 16px !important; } .c { font-size: 0.9em; font: inherit; line-height: 14px; }';
    expect(scaleFontSizes(untouched)).toBe(untouched);
  });
  it('applies only to the app\'s own CSS', () => {
    const plugin = textScale();
    plugin.configResolved({ root: '/repo/app' });
    expect(plugin.transform('.a{font-size:14px}', '/repo/app/src/styles/base.css').code).toContain('var(--text-scale, 1)');
    expect(plugin.transform('.a{font-size:14px}', '/repo/app/src/styles/base.css?inline').code).toContain('var(--text-scale, 1)');
    expect(plugin.transform('.a{font-size:14px}', '/repo/app/node_modules/maplibre-gl/dist/maplibre-gl.css')).toBeNull();
    expect(plugin.transform('.a{font-size:14px}', '/repo/app/src/main.js')).toBeNull();
    expect(plugin.transform('.a{color:red}', '/repo/app/src/x.css')).toBeNull();
  });
});
