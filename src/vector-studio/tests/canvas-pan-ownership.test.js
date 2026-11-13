import { describe, expect, it, vi } from 'vitest';
import { CanvasInput } from '../src/input.js';
import { Viewport } from '../src/render/viewport.js';

function setup() {
  const app = { editor: { view: new Viewport(), viewChanged: vi.fn() }, tool: { cursor: 'crosshair', onHover: vi.fn() }, setCanvasCursor: vi.fn() };
  const input = new CanvasInput(app, document.createElement('div'));
  const pointer = (x, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 1, buttons: 4, pressure: 0.5, clientX: x, clientY: 100, ...extra });
  input.down(pointer(100));
  input.move(pointer(120));
  expect(app.editor.view.panX).toBe(20);
  return { app, input, pointer };
}

describe('middle-button pan ownership', () => {
  it('ignores a hovering pen while the mouse is panning', () => {
    const { app, input, pointer } = setup();
    input.move(pointer(500, { pointerId: 7, pointerType: 'pen', button: -1, buttons: 0 }));
    expect(app.editor.view.panX).toBe(20);
    input.move(pointer(130));
    expect(app.editor.view.panX).toBe(30);
    input.up(pointer(130));
    expect(input.pan).toBeNull();
  });

  it.each(['up', 'cancel'])('does not end on another pointer’s %s event', (method) => {
    const { app, input, pointer } = setup();
    input[method](pointer(500, { pointerId: 7, pointerType: 'pen', buttons: 0 }));
    input.move(pointer(130));
    expect(app.editor.view.panX).toBe(30);
    expect(input.pan).toBeTruthy();
    input.up(pointer(130));
    expect(input.pan).toBeNull();
  });

  it('restores the tool cursor when the owning pointer is cancelled', () => {
    const { app, input, pointer } = setup();
    input.cancel(pointer(120));
    expect(input.pan).toBeNull();
    expect(app.setCanvasCursor).toHaveBeenLastCalledWith('crosshair');
  });
});
