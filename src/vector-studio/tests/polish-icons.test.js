import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { hasIcon, icon } from '../src/ui/icons.js';

describe('icons', () => {
  it('every tool and panel has its own icon (none falls back to the placeholder)', async () => {
    const app = await bootAppWithFeatures();
    const missing = [];
    for (const [id, cls] of app.toolClasses) if (!hasIcon(cls.icon)) missing.push(`tool ${id}: ${cls.icon}`);
    for (const [id, p] of app.dock.panels) if (!hasIcon(p.constructor.icon)) missing.push(`panel ${id}: ${p.constructor.icon}`);
    expect(missing).toEqual([]);
  });

  it('draws on one 24px grid with outline strokes in currentColor', async () => {
    const app = await bootAppWithFeatures();
    const names = new Set([...app.toolClasses.values()].map((c) => c.icon).concat([...app.dock.panels.values()].map((p) => p.constructor.icon)));
    const odd = [];
    for (const name of names) {
      const svg = icon(name, 20);
      if (svg.getAttribute('viewBox') !== '0 0 24 24') odd.push(`${name}: viewBox ${svg.getAttribute('viewBox')}`);
      if (svg.getAttribute('stroke') !== 'currentColor') odd.push(`${name}: stroke ${svg.getAttribute('stroke')}`);
      if (svg.getAttribute('stroke-width') !== '2') odd.push(`${name}: stroke-width ${svg.getAttribute('stroke-width')}`);
      // Detail strokes may be finer, never heavier than the outline (0 for filled-only shapes).
      for (const el of svg.querySelectorAll('[stroke-width]')) {
        const w = Number(el.getAttribute('stroke-width'));
        if (el !== svg && w !== 0 && !(w >= 0.75 && w <= 2.5)) odd.push(`${name}: inner stroke-width ${w}`);
      }
      for (const el of svg.querySelectorAll('[fill]')) {
        const f = el.getAttribute('fill');
        if (el !== svg && f !== 'currentColor' && f !== 'none') odd.push(`${name}: fill ${f}`);
      }
    }
    expect(odd).toEqual([]);
  });
});
