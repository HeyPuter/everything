// Dragging a guide out of a ruler with a finger.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './helpers.js';

describe('ruler guides by touch', () => {
  it('the rulers take touch drags and count as click targets for finger presses', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'shell.css'), 'utf8');
    expect(css).toMatch(/\.has-rulers \.ruler \{[^}]*touch-action: none/);
    // Touch screens move a press to the nearest element with mouse listeners.
    const added = [];
    const orig = HTMLCanvasElement.prototype.addEventListener;
    HTMLCanvasElement.prototype.addEventListener = function (type, ...rest) {
      if (this.classList.contains('ruler')) added.push(`${this.className}:${type}`);
      return orig.call(this, type, ...rest);
    };
    try {
      bootApp();
    } finally {
      HTMLCanvasElement.prototype.addEventListener = orig;
    }
    expect(added).toContain('ruler ruler-top:mousedown');
    expect(added).toContain('ruler ruler-left:mousedown');
  });

  it('a drag the system takes over (pointercancel) adds no guide and clears the preview', () => {
    const app = bootApp();
    const ed = app.newDocument();
    ed.setViewOption('rulers', true);
    app.canvasHost.getBoundingClientRect = () => ({
      left: 100,
      top: 90,
      right: 1000,
      bottom: 800,
      width: 900,
      height: 710,
    });
    const ruler = document.querySelector('.ruler-top');
    ruler.setPointerCapture = () => {};
    const ev = (type, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      e.pointerId = 1;
      ruler.dispatchEvent(e);
    };
    ev('pointerdown', 300, 80);
    ev('pointermove', 300, 300);
    expect(ed.alignmentGuides).not.toBe(null);
    ev('pointercancel', 300, 300);
    expect(ed.alignmentGuides).toBe(null);
    expect(ed.doc.root.guides || []).toHaveLength(0);
    // The canceled drag's listeners are gone: a later move or release does nothing.
    ev('pointermove', 300, 400);
    expect(ed.alignmentGuides).toBe(null);
    ev('pointerup', 300, 400);
    expect(ed.doc.root.guides || []).toHaveLength(0);
    // A normal drag still works afterwards.
    ev('pointerdown', 300, 80);
    ev('pointermove', 300, 300);
    ev('pointerup', 300, 300);
    expect(ed.doc.root.guides).toHaveLength(1);
  });
});
