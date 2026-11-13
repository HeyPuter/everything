import { describe, it, expect, vi } from 'vitest';
import { bootApp } from './helpers.js';

let time = 0;
const ptr = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, timeStamp: time += 1000 });

function setup(tool) {
  const app = bootApp();
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.setTool(tool);
  app.input.down(ptr(200, 200));
  app.input.move(ptr(300, 300));
  return { app, ed };
}

describe('navigation gesture cancellation', () => {
  it('removes the zoom marquee when a pointer is cancelled', () => {
    const { app, ed } = setup('zoom');
    const ctx = { save() {}, restore() {}, setLineDash() {}, strokeRect: vi.fn() };
    app.tool.drawOverlay(ctx);
    expect(ctx.strokeRect).toHaveBeenCalledOnce();
    app.input.cancel({ pointerId: 1 });
    ctx.strokeRect.mockClear();
    app.tool.drawOverlay(ctx);
    expect(ctx.strokeRect).not.toHaveBeenCalled();
    expect(ed.view.zoom).toBe(1);
    expect(app.input.active).toBeNull();
  });

  it('returns the Hand cursor to its idle state on cancellation', () => {
    const { app, ed } = setup('hand');
    expect(app.tool.cursor).toBe('grabbing');
    const pan = [ed.view.panX, ed.view.panY];
    app.input.cancel({ pointerId: 1 });
    expect(app.tool.cursor).toBe('grab');
    app.input.move(ptr(400, 400));
    expect([ed.view.panX, ed.view.panY]).toEqual(pan);
  });

  it.each(['hand', 'zoom', 'rotate-view'])('clears %s gesture state when the tool is deactivated', (id) => {
    const { app } = setup(id);
    const tool = app.tool;
    app.setTool('selection');
    expect(tool.drag).toBeFalsy();
    app.setTool(id);
    expect(app.tool.drag).toBeFalsy();
  });
});
