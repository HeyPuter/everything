import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { easeT, lerpColor, blendSteps, DEFAULT_BLEND } from '../src/features/artboards/blend-math.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });

function setup() {
  const ed = app.newDocument({ name: 'Blend', width: 400, height: 200 });
  const doc = ed.doc;
  const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000'), stroke: null });
  const b = createPath(rectangle(300, 0, 10, 10), true, { fill: solid('#0000ff'), stroke: null });
  doc.transact('B', () => [a, b].forEach((n) => doc.insert(n, doc.layers()[0].id)));
  const panel = app.dock.panels.get('blend');
  panel.ensureBuilt();
  return { ed, doc, a, b, panel };
}

const centers = (doc, g) => blendSteps(doc, g).runs[0].nodes.map((n) => nodeBounds(doc, n).x + 5);

describe('blend easing and colors', () => {
  it('eases step positions', () => {
    expect(easeT(0.5, 'linear')).toBe(0.5);
    expect(easeT(0.5, 'in', 0.5)).toBeLessThan(0.5);
    expect(easeT(0.5, 'out', 0.5)).toBeGreaterThan(0.5);
    expect(easeT(0.5, 'inOut', 0.5)).toBeCloseTo(0.5);
    expect(easeT(0.25, 'inOut', 0.5)).toBeLessThan(0.25);
    expect(easeT(0.3, 'in', 0)).toBeCloseTo(0.3);
    expect(easeT(0, 'out')).toBe(0);
    expect(easeT(1, 'in')).toBe(1);
  });

  it('blends colors straight or around the hue wheel', () => {
    expect(lerpColor('#ff0000', '#0000ff', 0.5)).toBe('#800080');
    // Red to blue the short way passes magenta; the long way passes green.
    expect(lerpColor('#ff0000', '#0000ff', 0.5, 'hue')).toBe('#ff00ff');
    expect(lerpColor('#ff0000', '#0000ff', 0.5, 'hueLong')).toBe('#00ff00');
    // A gray end keeps the other end's hue.
    expect(lerpColor('#808080', '#ff0000', 0.5, 'hue')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('Blend panel', () => {
  it('is in the Window menu and edits the selected blend live', async () => {
    const { ed, doc, a, b, panel } = setup();
    expect(app.commands.get('panel.blend')).toBeTruthy();
    ed.select([a.id, b.id]);
    panel.update();
    expect(panel.status.textContent).toMatch(/Make/);
    panel.cmdButtons.find((x) => x.dataset.cmd === 'blend.make').click();
    await new Promise((r) => setTimeout(r, 0));
    const gid = ed.topSelection()[0];
    expect(doc.get(gid).blend).toBeTruthy();
    panel.update();
    panel.apply({ spacing: 'steps', steps: 3 });
    expect(doc.get(gid).blend).toMatchObject({ spacing: 'steps', steps: 3 });
    const even = centers(doc, doc.get(gid));
    expect(even.map(Math.round)).toEqual([80, 155, 230]);
    panel.apply({ easing: 'in', easeAmount: 0.5 });
    const eased = centers(doc, doc.get(gid));
    expect(eased[0]).toBeLessThan(even[0]);
    expect(eased[2]).toBeLessThan(even[2]);
    panel.apply({ colorMode: 'hue', easeColor: false });
    const mid = blendSteps(doc, doc.get(gid)).runs[0].nodes[1].fill.color;
    expect(mid).toBe('#ff00ff');
    // A live slider drag is one undo step.
    const before = doc.undoStack.length;
    panel.apply({ easeAmount: 0.6 }, { live: true });
    panel.apply({ easeAmount: 0.7 }, { live: true });
    expect(doc.undoStack.length).toBe(before + 1);
    panel.update();
    expect(panel.amountOut.textContent).toBe('70%');
    expect(panel.easePreview.querySelectorAll('.bp-dot').length).toBe(3);
    expect(panel.colorPreview.querySelectorAll('.bp-swatch').length).toBe(5);
    // Orientation buttons.
    panel.orient[1].click();
    expect(doc.get(gid).blend.orientation).toBe('path');
    panel.update();
    expect(panel.orient[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('sets the options for new blends when no blend is selected', () => {
    const { ed, panel } = setup();
    ed.clearSelection();
    panel.apply({ spacing: 'distance', distance: 12 });
    expect(app.prefs.get('blendOptions')).toMatchObject({ spacing: 'distance', distance: 12 });
    panel.menu().find((x) => x.label === 'Reset Options').run();
    expect(app.prefs.get('blendOptions')).toMatchObject(DEFAULT_BLEND);
    expect(panel.menu()).toContain('blend.options');
  });
});
