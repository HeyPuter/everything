import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { createPlaylistView } from '../src/playlist/view.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ canvas: document.createElement('canvas'), overlay: document.createElement('canvas'), frame: vi.fn(), resize: vi.fn() }) }));
const panels = [];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  for (const panel of panels.splice(0)) panel.onHide();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup() {
  const body = document.createElement('div');
  document.body.append(body);
  const app = new App(body, { storage: { getItem: () => null, setItem() {} } });
  app.prefs.merge('playlistUi', { pickerW: 200 });
  const panel = createPlaylistView(app, { body });
  panels.push(panel);
  const split = body.querySelector('.pl-picker-split');
  const picker = body.querySelector('.pl-picker');
  const root = picker.parentElement;
  const width = () => parseFloat(root.style.getPropertyValue('--pl-picker-w'));
  Object.defineProperty(picker, 'offsetWidth', { get: width });
  split.setPointerCapture = vi.fn();
  split.releasePointerCapture = vi.fn();
  const pointer = (type, x = 200, id = 1) => {
    const e = new MouseEvent(type, { button: 0, clientX: x, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: id });
    split.dispatchEvent(e);
  };
  return { app, panel, split, width, pointer };
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'panel hide', 'picker hide'])('finishes picker resizing on %s and ignores stale movement', (end) => {
  const { app, panel, width, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 250);
  expect(width()).toBe(250);
  if (end === 'blur') window.dispatchEvent(new Event('blur'));
  else if (end === 'panel hide') panel.onHide();
  else if (end === 'picker hide') panel.toolbar.querySelector('[aria-label="Show clip sources"]').click();
  else pointer(end, end === 'pointerup' ? 250 : 0);
  expect(app.prefs.get('playlistUi').pickerW).toBe(250);
  expect(width()).toBe(250);
  pointer('pointermove', 340);
  pointer('pointerup', 340);
  expect(app.prefs.get('playlistUi').pickerW).toBe(250);
  expect(width()).toBe(250);
  if (end === 'picker hide') panel.toolbar.querySelector('[aria-label="Show clip sources"]').click();
  pointer('pointerdown', 250, 2);
  pointer('pointermove', 270, 2);
  pointer('pointerup', 270, 2);
  expect(app.prefs.get('playlistUi').pickerW).toBe(270);
});

it.each(['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'pointerdown'])('ignores a competing pointer %s during picker resizing', (event) => {
  const { app, width, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 230);
  pointer(event, 320, 2);
  expect(width()).toBe(230);
  expect(app.prefs.get('playlistUi').pickerW).toBe(200);
  pointer('pointermove', 250);
  pointer('pointerup', 250);
  expect(width()).toBe(250);
  expect(app.prefs.get('playlistUi').pickerW).toBe(250);
  pointer('pointermove', 350, 2);
  pointer('pointerup', 350, 2);
  expect(width()).toBe(250);
  expect(app.prefs.get('playlistUi').pickerW).toBe(250);
});

it('preserves keyboard sizing and pointer bounds', () => {
  const { app, split, width, pointer } = setup();
  const key = (key, shiftKey = false) => split.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  key('ArrowRight');
  expect(width()).toBe(210);
  key('ArrowLeft', true);
  expect(width()).toBe(170);
  pointer('pointerdown', 170);
  pointer('pointermove', -100);
  expect(width()).toBe(110);
  pointer('pointermove', 900);
  expect(width()).toBe(360);
  pointer('pointerup', 900);
  expect(app.prefs.get('playlistUi').pickerW).toBe(360);
  pointer('lostpointercapture', 0);
  expect(width()).toBe(360);
  key('ArrowRight', true);
  expect(width()).toBe(360);
});

it('continues from the dragged width when switching to keyboard resizing', () => {
  const { app, split, width, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 250);
  split.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(width()).toBe(260);
  expect(app.prefs.get('playlistUi').pickerW).toBe(260);
  pointer('pointermove', 330);
  pointer('pointerup', 330);
  expect(width()).toBe(260);
});
