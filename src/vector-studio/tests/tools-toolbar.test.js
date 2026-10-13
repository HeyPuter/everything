import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});

const toolButton = (label) => [...app.toolbar.el.querySelectorAll('.tool-btn')].find((b) => b.getAttribute('aria-label') === label);
const key = (k, code, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, ...extra }));

describe('Tools panel groups', () => {
  it('keeps the Magic Wand, Lasso and Curvature tools in groups of their own', () => {
    for (const label of ['Magic Wand Tool', 'Lasso Tool', 'Curvature Tool']) {
      const b = toolButton(label);
      expect(b, label).toBeTruthy();
      expect(b._ids).toHaveLength(1);
    }
    expect(toolButton('Pen Tool')._ids).toEqual(['pen', 'add-anchor', 'delete-anchor', 'anchor-point']);
  });

  it('shows the shortcut in tool tips', () => {
    expect(toolButton('Selection Tool').getAttribute('data-tip')).toBe('Selection Tool (V)');
  });
});

describe('tear-off tool strips', () => {
  it('tears a flyout off into a floating strip that follows the active tool', () => {
    const btn = toolButton('Rectangle Tool');
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const flyout = document.querySelector('.tool-flyout');
    expect(flyout).toBeTruthy();
    const tear = flyout.querySelector('.flyout-tearoff');
    expect(tear.textContent).toContain('Tear Off');
    tear.click();
    expect(document.querySelector('.tool-flyout')).toBe(null);
    const strip = document.querySelector('.tool-tearoff');
    expect(strip.getAttribute('role')).toBe('toolbar');
    const btns = [...strip.querySelectorAll('.tool-btn')];
    expect(btns.map((b) => b.getAttribute('aria-label'))).toEqual(btn._ids.map((id) => app.toolClasses.get(id).label));
    btns[2].click();
    expect(app.toolId).toBe('ellipse');
    expect(btns[2].getAttribute('aria-pressed')).toBe('true');
    app.setTool('star');
    expect(btns[2].getAttribute('aria-pressed')).toBe('false');
    expect(btns.find((b) => b.getAttribute('aria-label') === 'Star Tool').getAttribute('aria-pressed')).toBe('true');
    // Orientation toggle and keyboard navigation.
    strip.querySelector('[aria-label="Toggle orientation"]').click();
    expect(strip.classList.contains('vertical')).toBe(true);
    expect(strip.getAttribute('aria-orientation')).toBe('vertical');
    btns[0].focus();
    btns[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(btns[1]);
    strip.querySelector('[aria-label^="Close"]').click();
    expect(document.querySelector('.tool-tearoff')).toBe(null);
  });

  it('has no tear-off entry for single tools or the All Tools list', () => {
    expect(toolButton('Selection Tool').getAttribute('aria-haspopup')).toBe(null);
    app.toolbar.closeFlyout();
  });
});

describe('fill and stroke keys', () => {
  function addRect() {
    const doc = app.editor.doc;
    const node = createPath(rectangle(0, 0, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: { type: 'solid', color: '#0000ff' } });
    doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
    app.editor.select([node.id]);
    return node.id;
  }

  it('X toggles focus, Shift+X swaps, D resets, / none and < > color or gradient', () => {
    const id = addRect();
    const doc = app.editor.doc;
    expect(app.editor.focusPaint).toBe('fill');
    key('x', 'KeyX');
    expect(app.editor.focusPaint).toBe('stroke');
    key('X', 'KeyX', { shiftKey: true });
    expect(doc.get(id).fill.color).toBe('#0000ff');
    expect(doc.get(id).stroke.color).toBe('#ff0000');
    key('/', 'Slash');
    expect(doc.get(id).stroke).toBe(null);
    key('<', 'Comma', { shiftKey: true });
    expect(doc.get(id).stroke.type).toBe('solid');
    key('>', 'Period', { shiftKey: true });
    expect(doc.get(id).stroke.type).toMatch(/linear|radial/);
    key('d', 'KeyD');
    expect(doc.get(id).fill.color).toBe('#ffffff');
    expect(doc.get(id).stroke.color).toBe('#000000');
  });
});
