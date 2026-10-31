import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config.js';

for (const entry of ['index.html', 'mock.html']) {
  const html = readFileSync(resolve(entry), 'utf8');
  function boot(theme, blocked = false) {
    return new JSDOM(html, {
      url: 'https://trips.puter.com/',
      runScripts: 'dangerously',
      beforeParse(window) {
        if (blocked) {
          Object.defineProperty(window, 'localStorage', {
            get() { throw new window.DOMException('Storage disabled', 'SecurityError'); },
          });
        } else if (theme !== null) window.localStorage.setItem('trips:theme', theme);
      },
    });
  }

  describe(entry, () => {
    it.each(['light', 'dark'])('restores %s before the module runs', (theme) => {
      const dom = boot(theme);
      expect(dom.window.document.documentElement.dataset.theme).toBe(theme);
      expect([...dom.window.document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.content))
        .toEqual(Array(2).fill(theme === 'dark' ? '#0b0b0d' : '#f1f1ee'));
      dom.window.close();
    });

    it.each([null, 'system', 'invalid', '<script>'])('leaves %s to the system theme', (theme) => {
      const dom = boot(theme);
      expect(dom.window.document.documentElement.hasAttribute('data-theme')).toBe(false);
      dom.window.close();
    });

    it('boots when local storage is blocked', () => {
      const dom = boot(null, true);
      expect(dom.window.document.documentElement.hasAttribute('data-theme')).toBe(false);
      expect(dom.window.document.getElementById('app')).not.toBeNull();
      dom.window.close();
    });

    it('loads the hosted SDK only in production', () => {
      const dom = boot(null);
      const sdk = dom.window.document.querySelector('script[src="https://js.puter.com/v2/"]');
      if (entry === 'index.html') expect(sdk?.defer).toBe(true);
      else expect(sdk).toBeNull();
      dom.window.close();
    });
  });
}

describe('build inputs', () => {
  it('keeps mock and kit pages out of the production build', () => {
    const production = viteConfig({ mode: 'production', command: 'build' }).build;
    const mock = viteConfig({ mode: 'mock', command: 'build' }).build;
    expect(Object.keys(production.rollupOptions.input)).toEqual(['app']);
    expect(Object.keys(mock.rollupOptions.input).sort()).toEqual(['app', 'kit', 'mock']);
    expect(mock.outDir).not.toBe(production.outDir);
  });
});
