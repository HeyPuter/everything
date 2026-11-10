// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { LayerManager } from '../src/ui/layers.js';
import { PropertiesPalette } from '../src/ui/properties.js';
import { BlockLibrary } from '../src/ui/blocks.js';

/**
 * A browser drops a scroller's position when the content under it goes away
 * with the focused control in it. jsdom does no layout, so say it the same way:
 * the scroller is back at the start as soon as `content` loses a child.
 */
function dropScrollWhenEmptied(scroller, content) {
  const remove = Element.prototype.remove;
  vi.spyOn(Element.prototype, 'remove').mockImplementation(function () {
    if (this.parentNode === content) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
    return remove.call(this);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('palettes keep their scroll position when they re-render', () => {
  it('layer list', () => {
    const d = new Drawing();
    d.transaction('layers', () => {
      for (let i = 0; i < 40; i++) d.setTable('layers', `L${i}`, { ...d.layers.get('0'), name: `L${i}` });
    });
    const lm = new LayerManager({ doc: { drawing: d } });
    document.body.append(lm.el);
    lm.render();
    const scroller = lm.el.querySelector('.lm-scroll');
    scroller.scrollTop = 900;
    scroller.scrollLeft = 120;
    dropScrollWhenEmptied(scroller, lm.tbody);
    lm.render();
    expect(scroller.scrollTop).toBe(900);
    expect(scroller.scrollLeft).toBe(120);
  });

  it('properties', () => {
    const d = new Drawing();
    let id;
    const pts = [];
    for (let i = 0; i < 40; i++) pts.push(i, i % 2, 0);
    d.transaction('add', () => (id = d.add({ type: 'polyline', pts, closed: false, layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1 }).id));
    const p = new PropertiesPalette({ doc: { drawing: d, selection: new Set([id]) }, camera: {}, run() {} });
    const dockBody = document.createElement('div');
    dockBody.append(p.el);
    document.body.append(dockBody);
    p.render();
    dockBody.scrollTop = 700;
    dropScrollWhenEmptied(dockBody, p.body);
    p.render();
    expect(dockBody.scrollTop).toBe(700);
  });

  it('block list', () => {
    globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
    const d = new Drawing();
    d.transaction('blocks', () => {
      for (let i = 0; i < 40; i++) d.setBlock(`B${i}`, { name: `B${i}`, base: { x: 0, y: 0 }, entities: [] });
    });
    const bl = new BlockLibrary({ doc: { drawing: d }, run() {} });
    const dockBody = document.createElement('div');
    dockBody.append(bl.el);
    document.body.append(dockBody);
    bl.render();
    dockBody.scrollTop = 1200;
    dropScrollWhenEmptied(dockBody, bl.grid);
    bl.render();
    expect(dockBody.scrollTop).toBe(1200);
  });
});
