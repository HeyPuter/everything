// Tooltips (data-tip): shown on hover anywhere in the app, including inside modal dialogs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installTooltips, openDialog } from '../src/ui/dialog.js';
import { h } from '../src/lib/dom.js';

const hover = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  vi.useRealTimers();
});

describe('tooltips', () => {
  it('show for buttons inside a modal dialog, in the dialog so they sit above it', () => {
    const page = h('div');
    document.body.append(page);
    installTooltips(page);
    const btn = h('button', { type: 'button', 'data-tip': 'Match case' }, 'Aa');
    const d = openDialog({ title: 'Find and replace', body: btn });
    hover(btn);
    vi.advanceTimersByTime(500);
    const tips = document.querySelectorAll('.tooltip');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe('Match case');
    expect(d.el.contains(tips[0])).toBe(true);
    d.close();
  });

  it('install once however many screens ask for them', () => {
    const a = h('div');
    document.body.append(a);
    installTooltips(a);
    installTooltips(a);
    installTooltips(document.body);
    const btn = h('button', { type: 'button', 'data-tip': 'Play' });
    a.append(btn);
    hover(btn);
    vi.advanceTimersByTime(500);
    expect(document.querySelectorAll('.tooltip').length).toBe(1);
    expect(document.querySelector('.tooltip').parentNode).toBe(document.body);
  });
});
