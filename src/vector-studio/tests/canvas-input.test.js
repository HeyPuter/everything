import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { IS_MAC } from '../src/commands/registry.js';

// Key handlers listen on the document: one app per file, or an earlier app's handler takes the keys.
const MOD = IS_MAC ? ['Meta', 'MetaLeft', { metaKey: true }] : ['Control', 'ControlLeft', { ctrlKey: true }];

const key = (type, k, code = k, extra = {}) => document.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, ...extra }));
// Presses a second apart, so no two count as a double-click.
let clock = 0;
const ptr = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, timeStamp: (clock += 1000), ...extra });

describe('temporary tools released mid-drag', () => {
  let app;
  beforeAll(() => {
    app = bootApp();
    app.newDocument();
  });
  beforeEach(() => {
    app.input.setTempTool(null);
    app.input.spaceDown = false;
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('rectangle');
    app.canvasHost.focus();
  });

  it('returns to the tool when Space is released before the Hand drag ends', () => {
    key('keydown', ' ', 'Space');
    expect(app.input.currentTool().id).toBe('hand');
    app.input.down(ptr(100, 100));
    app.input.move(ptr(150, 120));
    key('keyup', ' ', 'Space');
    // The pan goes on until the button is released.
    expect(app.input.currentTool().id).toBe('hand');
    app.input.up(ptr(150, 120));
    expect(app.input.tempTool).toBe(null);
    expect(app.input.currentTool().id).toBe('rectangle');
  });

  it('returns to the tool when Command is released before the Selection drag ends', () => {
    key('keydown', ...MOD);
    expect(app.input.currentTool().id).toBe('selection');
    app.input.down(ptr(100, 100, MOD[2]));
    app.input.move(ptr(150, 120, MOD[2]));
    key('keyup', MOD[0], MOD[1]);
    app.input.up(ptr(150, 120));
    expect(app.input.tempTool).toBe(null);
    expect(app.input.currentTool().id).toBe('rectangle');
  });

  it('returns to the tool when the window loses focus during a temporary-tool drag', () => {
    key('keydown', ' ', 'Space');
    app.input.down(ptr(100, 100));
    window.dispatchEvent(new Event('blur'));
    app.input.up(ptr(150, 120));
    expect(app.input.spaceDown).toBe(false);
    expect(app.input.currentTool().id).toBe('rectangle');
  });

  it('keeps the temporary tool while its key is still held after the drag', () => {
    key('keydown', ' ', 'Space');
    app.input.down(ptr(100, 100));
    app.input.up(ptr(150, 120));
    expect(app.input.currentTool().id).toBe('hand');
    key('keyup', ' ', 'Space');
    expect(app.input.currentTool().id).toBe('rectangle');
  });
});
