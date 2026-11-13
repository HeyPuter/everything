import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasInput } from '../src/input.js';

// Event deduplication must depend on an actual preceding event, not page age.
function setup(now) {
  vi.spyOn(performance, 'now').mockReturnValue(now);
  const app = { editor: {}, showContextMenu: vi.fn() };
  const input = new CanvasInput(app, document.createElement('div'));
  const event = { pointerId: 7, pointerType: 'pen', button: 2, buttons: 2, clientX: 200, clientY: 100, preventDefault: vi.fn() };
  return { app, input, event };
}

afterEach(() => vi.restoreAllMocks());

describe('context menus immediately after loading', () => {
  it('opens the first mouse context menu before any pen has lifted', () => {
    const { app, input, event } = setup(100);
    input.contextMenu({ ...event, pointerType: 'mouse' });
    expect(app.showContextMenu).toHaveBeenCalledWith(200, 100);
  });

  it('opens the first pen side-button menu before any native context menu', () => {
    const { app, input, event } = setup(100);
    input.down(event);
    expect(app.showContextMenu).toHaveBeenCalledWith(200, 100);
    input.contextMenu(event);
    expect(app.showContextMenu).toHaveBeenCalledTimes(1);
  });

  it('still suppresses a native pen hold immediately after a real lift', () => {
    const { app, input, event } = setup(100);
    input.penLifted = 90;
    input.contextMenu(event);
    expect(app.showContextMenu).not.toHaveBeenCalled();
  });

  it('still deduplicates a side-button event following a real native menu', () => {
    const { app, input, event } = setup(100);
    input.lastContextMenu = 90;
    input.down(event);
    expect(app.showContextMenu).not.toHaveBeenCalled();
  });
});
