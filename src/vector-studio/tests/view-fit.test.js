import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Viewport } from '../src/render/viewport.js';

/** The artboard's rect on screen (canvas pixels). */
function onScreen(ed, i = 0) {
  const a = ed.artboard(i);
  const p = ed.view.toScreen(a.x, a.y);
  const q = ed.view.toScreen(a.x + a.w, a.y + a.h);
  return { top: p.y, left: p.x, bottom: ed.view.height - q.y, right: ed.view.width - q.x };
}

describe('fit in window', () => {
  let app;
  let size;
  const resize = (w, h) => {
    size = { width: w, height: h };
    app.views.get(app.editor).resize();
  };
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    size = { width: 0, height: 0 };
    app.newDocument({ width: 612, height: 792 });
    app.views.get(app.editor).host.getBoundingClientRect = () => ({ left: 0, top: 0, ...size, right: size.width, bottom: size.height });
  });

  it('centers a rect between per-side margins', () => {
    const v = new Viewport();
    v.set({ width: 1000, height: 800 });
    v.fit({ x: 0, y: 0, w: 100, h: 100 }, { top: 50, right: 50, bottom: 150, left: 50 });
    expect(v.zoom).toBeCloseTo(6);
    expect(v.toScreen(0, 0).y).toBeCloseTo(50);
    expect(v.toScreen(100, 100).y).toBeCloseTo(650);
    expect(v.toScreen(50, 0).x).toBeCloseTo(500);
  });

  it('keeps the artboard clear of the task bar where it rests', () => {
    resize(994, 761);
    const m = onScreen(app.editor);
    expect(Math.min(m.top, m.left, m.right)).toBeGreaterThanOrEqual(47.9);
    // The bar rests 28 px above the bottom edge; the art stays 16 px clear of it.
    const bar = app.canvasOverlayInsets();
    expect(bar.bottom).toBeGreaterThan(28);
    expect(m.bottom).toBeGreaterThanOrEqual(bar.bottom + 16 - 0.1);
    // Fit Artboard and Fit All agree with the first fit.
    app.editor.view.stepZoom(1);
    app.commands.run('view.fitArtboard');
    expect(onScreen(app.editor)).toEqual(m);
    app.commands.run('view.fitAll');
    expect(onScreen(app.editor)).toEqual(m);
    // Without the task bar the margin is the same on every side.
    app.prefs.set('contextualTaskbar', false);
    app.commands.run('view.fitArtboard');
    expect(onScreen(app.editor).bottom).toBeCloseTo(onScreen(app.editor).top);
  });

  it('fits again when the canvas settles to its size, until the view is zoomed or moved', () => {
    // The first fit can come before rulers and bars are laid out.
    resize(1012, 831);
    resize(994, 761);
    const settled = onScreen(app.editor);
    app.commands.run('view.fitArtboard');
    expect(onScreen(app.editor)).toEqual(settled);
    // Zoomed: a resize keeps the zoom and the center.
    app.editor.view.stepZoom(1);
    const zoom = app.editor.view.zoom;
    const c = app.editor.view.toDoc(497, 380.5);
    resize(900, 700);
    expect(app.editor.view.zoom).toBe(zoom);
    const c2 = app.editor.view.toDoc(450, 350);
    expect(c2.x).toBeCloseTo(c.x);
    expect(c2.y).toBeCloseTo(c.y);
  });
});
