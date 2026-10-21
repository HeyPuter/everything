// Editor layout: side panel widths fit the window (saved widths are kept, shown widths leave
// room for the player), and canvas-drawn chrome follows theme changes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor, fitPanelWidths } from '../src/ui/editor.js';
import { prefs, setPref, setTheme } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';

describe('fitPanelWidths', () => {
  it('keeps widths that fit', () => {
    expect(fitPanelWidths(440, 360, 900)).toEqual([440, 360]);
    expect(fitPanelWidths(440, 360, Infinity)).toEqual([440, 360]);
  });

  it('takes the overflow from the panels in proportion to their extra width', () => {
    // 720 + 640 in 1000: 360 too wide; extra widths are 480 and 380.
    const [l, r] = fitPanelWidths(720, 640, 1000);
    expect(l + r).toBe(1000);
    expect(l).toBe(Math.round(720 - 480 * (360 / 860)));
  });

  it('never goes below the minimum widths', () => {
    expect(fitPanelWidths(720, 640, 300)).toEqual([240, 260]);
  });
});

describe('editor panel widths', () => {
  let editor;
  let root;
  let width;
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    width = 1400;
    setPref('leftW', 720);
    setPref('rightW', 640);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function clientWidth() {
      return this.classList.contains('workspace') ? width : 0;
    });
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    editor.el.dataset.layout = 'desktop';
  });
  afterEach(() => {
    editor.dispose();
    vi.restoreAllMocks();
    setPref('leftW', 440);
    setPref('rightW', 360);
  });

  const shown = () => [parseFloat(editor.el.style.getPropertyValue('--left-w')), parseFloat(editor.el.style.getPropertyValue('--right-w'))];

  it('shows saved widths narrowed to leave the player room, and keeps the saved ones', () => {
    editor.fitPanels();
    const [l, r] = shown();
    expect(l + r).toBeLessThanOrEqual(1400 - 8 - 280);
    expect(prefs().leftW).toBe(720);
    expect(prefs().rightW).toBe(640);
    width = 2400;
    editor.fitPanels();
    expect(shown()).toEqual([720, 640]);
  });

  it('stops a resizer where the player would get too narrow', () => {
    width = 1300;
    editor.applyLayout('default');
    const resizer = editor.el.querySelector('.resizer[aria-label="Resize media panel"]');
    for (let i = 0; i < 40; i++) resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    const [l, r] = shown();
    expect(r).toBe(360);
    expect(l).toBe(1300 - 8 - 280 - 360);
    expect(resizer.getAttribute('aria-valuenow')).toBe(String(l));
    expect(resizer.getAttribute('aria-valuemax')).toBe(String(l));
    expect(prefs().leftW).toBe(l);
  });

  it('fits layout presets to the window', () => {
    width = 1000;
    editor.applyLayout('media');
    const [l, r] = shown();
    expect(l + r).toBeLessThanOrEqual(1000 - 8 - 280);
    expect(prefs().leftW).toBe(600);
  });
});

describe('theme changes', () => {
  it('redraw the timeline and player rulers, until the editor is closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    const editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    const render = vi.spyOn(editor.ctx.timeline, 'render');
    const relayout = vi.spyOn(editor.ctx.playerView, 'relayout');
    setTheme('light');
    expect(render).toHaveBeenCalledWith(true);
    expect(relayout).toHaveBeenCalled();
    editor.dispose();
    render.mockClear();
    setTheme('dark');
    expect(render).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
