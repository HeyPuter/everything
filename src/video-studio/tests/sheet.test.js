import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSheet } from '../src/ui/sheet.js';
import { h } from '../src/lib/dom.js';

// jsdom does no layout; treat every element as rendered so the focus trap sees it.
const realRects = Element.prototype.getClientRects;
const realMatchMedia = window.matchMedia;

function setup({ reduced = true } = {}) {
  window.matchMedia = (q) => ({ matches: reduced && q.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} });
  const host = h('div.editor', h('header.topbar', h('button#opener', { type: 'button' }, 'Open')), h('main.workspace', h('button#other', { type: 'button' }, 'Other')));
  document.body.append(host);
  const onClose = vi.fn();
  const sheet = createSheet({ title: 'Filters', host, onClose });
  const a = h('button#first', { type: 'button' }, 'A');
  const skip = h('button#skip', { type: 'button', tabindex: '-1' }, 'Skip');
  const b = h('button#last', { type: 'button' }, 'B');
  sheet.setContent(a, skip, b);
  return { host, sheet, onClose, opener: host.querySelector('#opener'), a, b, skip };
}

function key(target, k, opts = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
}

describe('sheet', () => {
  beforeEach(() => {
    Element.prototype.getClientRects = function getClientRects() {
      return [{ width: 1, height: 1 }];
    };
  });
  afterEach(() => {
    Element.prototype.getClientRects = realRects;
    window.matchMedia = realMatchMedia;
    document.body.replaceChildren();
  });

  it('is a labelled modal dialog that focuses its first control and makes the rest inert', () => {
    const { sheet, opener, a, host } = setup();
    opener.focus();
    sheet.open(opener);
    const panel = sheet.el.querySelector('[role="dialog"]');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')).textContent).toBe('Filters');
    expect(sheet.el.hidden).toBe(false);
    expect(document.activeElement).toBe(a);
    expect(host.querySelector('.topbar').hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.workspace').hasAttribute('inert')).toBe(true);
    expect(sheet.isOpen).toBe(true);
  });

  it('traps Tab and Shift+Tab inside, skipping tabindex=-1', () => {
    const { sheet, opener, b } = setup();
    sheet.open(opener);
    const close = sheet.el.querySelector('.sheet-close');
    b.focus();
    const e1 = key(b, 'Tab');
    expect(e1.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const e2 = key(close, 'Tab', { shiftKey: true });
    expect(e2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
  });

  it('pulls focus back when it escapes to the page', () => {
    const { sheet, opener, a } = setup();
    sheet.open(opener);
    const outside = h('button', { type: 'button' }, 'Outside');
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(a);
  });

  it('closes on Escape, returns focus to the opener and keeps the key from editor shortcuts', () => {
    const { sheet, opener, a, host, onClose } = setup();
    const docKeys = vi.fn();
    document.addEventListener('keydown', docKeys);
    opener.focus();
    sheet.open(opener);
    key(a, 'Delete');
    expect(docKeys).not.toHaveBeenCalled();
    key(a, 'Escape');
    document.removeEventListener('keydown', docKeys);
    expect(docKeys).not.toHaveBeenCalled();
    expect(sheet.isOpen).toBe(false);
    expect(sheet.el.hidden).toBe(true); // reduced motion: hidden at once
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    expect(host.querySelector('[inert]')).toBe(null);
  });

  it('closes from the close button and the scrim', () => {
    const { sheet, opener } = setup();
    sheet.open(opener);
    sheet.el.querySelector('.sheet-close').click();
    expect(sheet.isOpen).toBe(false);
    sheet.open(opener);
    sheet.el.querySelector('.sheet-scrim').click();
    expect(sheet.isOpen).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps a sheet open when Escape belongs to composition (%j)', (composition) => {
    const { sheet, opener } = setup();
    const input = document.createElement('input');
    sheet.setContent(input);
    sheet.open(opener);
    try {
      const event = key(input, 'Escape', composition);
      expect(sheet.isOpen).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(false);
      key(input, 'Escape');
      expect(sheet.isOpen).toBe(false);
    } finally { sheet.dispose(); }
  });

  it('does not apply the opening frame after the sheet has already closed', () => {
    vi.useFakeTimers();
    const { sheet, opener } = setup({ reduced: false });
    try {
      sheet.open(opener);
      sheet.close();
      vi.advanceTimersByTime(20);
      expect(sheet.el.classList.contains('open')).toBe(false);
      expect(sheet.isOpen).toBe(false);
    } finally {
      sheet.dispose();
      vi.useRealTimers();
    }
  });

  it('waits for the slide-out without reduced motion', () => {
    vi.useFakeTimers();
    try {
      const { sheet, opener } = setup({ reduced: false });
      sheet.open(opener);
      sheet.close();
      expect(sheet.el.hidden).toBe(false);
      vi.advanceTimersByTime(300);
      expect(sheet.el.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on a swipe down the handle and snaps back on a short one', () => {
    const { sheet, opener } = setup();
    sheet.open(opener);
    const panel = sheet.panel;
    Object.defineProperty(panel, 'offsetHeight', { value: 400, configurable: true });
    const handle = sheet.el.querySelector('.sheet-handle');
    const pe = (type, y) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { button: 0, clientX: 10, clientY: y, pointerId: 1 });
      return e;
    };
    handle.dispatchEvent(pe('pointerdown', 100));
    handle.dispatchEvent(pe('pointermove', 115));
    expect(panel.style.transform).toBe('translateY(15px)');
    handle.dispatchEvent(pe('pointerup', 115));
    expect(sheet.isOpen).toBe(true);
    expect(panel.style.transform).toBe('');
    handle.dispatchEvent(pe('pointerdown', 100));
    handle.dispatchEvent(pe('pointermove', 260));
    handle.dispatchEvent(pe('pointerup', 260));
    expect(sheet.isOpen).toBe(false);
    expect(panel.style.transform).toBe(''); // let the closed-state CSS animate it offscreen
  });

  it('ignores movement and release from a second pointer during a sheet swipe', () => {
    const { sheet, opener } = setup();
    sheet.open(opener);
    const handle = sheet.el.querySelector('.sheet-handle');
    const send = (type, pointerId, y) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { button: 0, clientX: 10, clientY: y, pointerId });
      handle.dispatchEvent(e);
    };
    try {
      send('pointerdown', 1, 100);
      send('pointermove', 2, 260);
      expect(sheet.panel.style.transform).toBe('');
      send('pointerup', 2, 260);
      expect(sheet.isOpen).toBe(true);
      send('pointermove', 1, 130);
      expect(sheet.panel.style.transform).toBe('translateY(30px)');
      send('pointercancel', 1, 130);
      expect(sheet.panel.style.transform).toBe('');
      expect(sheet.isOpen).toBe(true);
    } finally { sheet.dispose(); }
  });

  it('does not start a competing swipe when another finger presses the handle', () => {
    const { sheet, opener } = setup();
    sheet.open(opener);
    const handle = sheet.el.querySelector('.sheet-handle');
    const send = (type, pointerId, y) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { button: 0, clientX: 10, clientY: y, pointerId });
      handle.dispatchEvent(e);
    };
    try {
      send('pointerdown', 1, 100);
      send('pointerdown', 2, 180);
      send('pointermove', 1, 130);
      expect(sheet.panel.style.transform).toBe('translateY(30px)');
      send('pointercancel', 1, 130);
    } finally { sheet.dispose(); }
  });

  it.each(['close', 'lostpointercapture'])('releases an unfinished swipe on %s', (end) => {
    const { sheet, opener } = setup();
    sheet.open(opener);
    const handle = sheet.el.querySelector('.sheet-handle');
    const send = (type, pointerId, y) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { button: 0, clientX: 10, clientY: y, pointerId });
      handle.dispatchEvent(e);
    };
    try {
      send('pointerdown', 1, 100);
      send('pointermove', 1, 130);
      if (end === 'close') sheet.close();
      else send('lostpointercapture', 1, 130);
      expect(sheet.panel.classList.contains('dragging')).toBe(false);
      expect(sheet.panel.style.transform).toBe('');
      send('pointermove', 1, 200);
      expect(sheet.panel.style.transform).toBe('');
      sheet.open(opener);
      send('pointerdown', 2, 40);
      send('pointermove', 2, 60);
      expect(sheet.panel.style.transform).toBe('translateY(20px)');
      send('pointercancel', 2, 60);
    } finally { sheet.dispose(); }
  });

  it('switches between bottom and side sheets', () => {
    const { sheet } = setup();
    expect(sheet.el.classList.contains('side-bottom')).toBe(true);
    sheet.setSide('end');
    expect(sheet.side).toBe('end');
    expect(sheet.el.classList.contains('side-end')).toBe(true);
    expect(sheet.el.classList.contains('side-bottom')).toBe(false);
  });
});
