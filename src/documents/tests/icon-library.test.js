import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { ICONS, ICON_CATEGORIES, iconSvg, searchIcons, getIcon } from '../src/lib/icon-library.js';
import { svgInfo } from '../src/engine/svg-images.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const bytes = svg => new TextEncoder().encode(svg);

describe('icon library', () => {
  it('has unique ids, known categories and enough icons in every category', () => {
    expect(ICONS.length).toBeGreaterThanOrEqual(90);
    expect(new Set(ICONS.map(i => i.id)).size).toBe(ICONS.length);
    const categories = new Set(ICON_CATEGORIES.map(c => c.id));
    for (const icon of ICONS) {
      expect(categories.has(icon.category), icon.id).toBe(true);
      expect(icon.name).toMatch(/^[A-Z][\w &-]+$/);
      expect(icon.keywords.length).toBeGreaterThan(0);
    }
    for (const { id } of ICON_CATEGORIES) expect(ICONS.filter(i => i.category === id).length, id).toBeGreaterThanOrEqual(5);
  });

  it('produces SVG the document image validator accepts at the requested size', () => {
    for (const icon of ICONS) {
      expect(svgInfo(bytes(iconSvg(icon.id))), icon.id).toEqual({ mime: 'image/svg+xml', width: 96, height: 96 });
    }
    expect(svgInfo(bytes(iconSvg('star', { size: 48 })))).toMatchObject({ width: 48, height: 48 });
  });

  it('writes explicit colors and stroke width instead of currentColor', () => {
    const svg = iconSvg('atom', { color: '#c00000', strokeWidth: 1.5 });
    expect(svg).not.toContain('currentColor');
    expect(svg).toContain('stroke="#C00000"');
    expect(svg).toContain('fill="#C00000"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="96" viewBox="0 0 24 24" fill="none"/);
    expect(iconSvg('heart', { color: 'red' })).toContain('stroke="#1F3864"');
    expect(() => iconSvg('missing')).toThrow(/Unknown icon/);
  });

  it('keeps geometry inside the 24-unit box', () => {
    for (const icon of ICONS) {
      const doc = new DOMParser().parseFromString(iconSvg(icon.id), 'image/svg+xml');
      for (const el of doc.querySelectorAll('circle')) {
        const [cx, cy, r] = ['cx', 'cy', 'r'].map(a => +el.getAttribute(a));
        expect(cx - r >= 0 && cx + r <= 24 && cy - r >= 0 && cy + r <= 24, icon.id).toBe(true);
      }
      for (const el of doc.querySelectorAll('polygon')) for (const v of el.getAttribute('points').split(/[ ,]/).map(Number)) expect(v >= 1 && v <= 23, icon.id).toBe(true);
    }
  });

  it('searches names, keywords and categories with every word required', () => {
    expect(searchIcons('')).toHaveLength(ICONS.length);
    expect(searchIcons('  ', 'food').every(i => i.category === 'food')).toBe(true);
    expect(searchIcons('cart').map(i => i.id)).toContain('cart');
    expect(searchIcons('SHOPPING').map(i => i.id)).toEqual(expect.arrayContaining(['cart', 'bag']));
    expect(searchIcons('shopping bag').map(i => i.id)).toEqual(['bag']);
    expect(searchIcons('weather').length).toBeGreaterThan(5);
    expect(searchIcons('finance').every(i => i.category === 'business')).toBe(true);
    expect(searchIcons('idea', 'education').map(i => i.id)).toEqual(['bulb']);
    expect(searchIcons('idea', 'food')).toEqual([]);
    expect(searchIcons('zzzz')).toEqual([]);
    expect(getIcon('bulb').name).toBe('Light bulb');
  });
});
