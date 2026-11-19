// Styled tooltips: shortcut key caps, placement, and the title attribute set aside only while shown.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { splitShortcut, placeTip, installTooltips } from '../src/ui/tooltip.js';

const over = (el, pointerType = 'mouse') => el.dispatchEvent(Object.assign(new Event('pointerover', { bubbles: true }), { pointerType }));
const out = (el, to = null) => el.dispatchEvent(Object.assign(new Event('pointerout', { bubbles: true }), { relatedTarget: to }));

describe('splitShortcut', () => {
  it('separates a keyboard shortcut in parentheses from the label', () => {
    expect(splitShortcut('Move Tool (V)')).toEqual({ label: 'Move Tool', key: 'V' });
    expect(splitShortcut('Open (⇧⌘O)')).toEqual({ label: 'Open', key: '⇧⌘O' });
    expect(splitShortcut('Save As (Ctrl+Shift+S)')).toEqual({ label: 'Save As', key: 'Ctrl+Shift+S' });
    expect(splitShortcut('Maximize Frame (`)')).toEqual({ label: 'Maximize Frame', key: '`' });
    expect(splitShortcut('Play (Space)')).toEqual({ label: 'Play', key: 'Space' });
  });

  it('leaves other parentheses in the label', () => {
    expect(splitShortcut('Free Space (Time)')).toEqual({ label: 'Free Space (Time)', key: '' });
    expect(splitShortcut('Gain (dB)')).toEqual({ label: 'Gain (dB)', key: '' });
    expect(splitShortcut('Plain')).toEqual({ label: 'Plain', key: '' });
  });
});

describe('placeTip', () => {
  const view = { width: 800, height: 600 };
  it('centers the tip below its anchor', () => {
    expect(placeTip({ left: 100, top: 10, bottom: 30, width: 40 }, { width: 60, height: 20 }, view)).toEqual({ left: 90, top: 36 });
  });
  it('flips above near the bottom and stays inside the window', () => {
    const p = placeTip({ left: 780, top: 570, bottom: 590, width: 20 }, { width: 100, height: 24 }, view);
    expect(p.top).toBe(570 - 6 - 24);
    expect(p.left).toBe(800 - 100 - 4);
  });
});

describe('installTooltips', () => {
  let api;
  afterEach(() => {
    api?.dispose();
    vi.useRealTimers();
  });

  it('shows the title in a tip after a short hover and puts the title back when the pointer leaves', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b" title="Razor Tool (R)">x</button><div id="o"></div>';
    api = installTooltips();
    const b = document.getElementById('b');
    over(b);
    expect(api.el.isConnected && !api.el.hidden).toBe(false);
    vi.advanceTimersByTime(600);
    expect(api.el.hidden).toBe(false);
    expect(api.el.querySelector('.tooltip-label').textContent).toBe('Razor Tool');
    expect(api.el.querySelector('.tooltip-key').textContent).toBe('R');
    // The browser's own tip would show too: the title is set aside meanwhile.
    expect(b.hasAttribute('title')).toBe(false);
    out(b, document.getElementById('o'));
    expect(api.el.hidden).toBe(true);
    expect(b.getAttribute('title')).toBe('Razor Tool (R)');
  });

  it('takes a title changed while the tip shows, and hides on a press', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b" title="Loop">x</button>';
    api = installTooltips();
    const b = document.getElementById('b');
    over(b);
    vi.advanceTimersByTime(600);
    b.title = 'Loop (L)';
    await Promise.resolve();
    expect(b.hasAttribute('title')).toBe(false);
    expect(api.el.querySelector('.tooltip-label').textContent).toBe('Loop');
    expect(api.el.querySelector('.tooltip-key').textContent).toBe('L');
    b.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(api.el.hidden).toBe(true);
    expect(b.getAttribute('title')).toBe('Loop (L)');
    // Pressed: no tip again until the pointer leaves.
    over(b);
    vi.advanceTimersByTime(600);
    expect(api.el.hidden).toBe(true);
  });

  it('never shows for touch', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b" title="Stop">x</button>';
    api = installTooltips();
    over(document.getElementById('b'), 'touch');
    vi.advanceTimersByTime(600);
    expect(api.target).toBe(null);
    expect(document.getElementById('b').getAttribute('title')).toBe('Stop');
  });
});
