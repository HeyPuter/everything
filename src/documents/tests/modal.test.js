// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openModal, closeAllModals, promptDialog, formDialog } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';
import { openColorMenu } from '../src/ui/colors.js';
import { closeMenu } from '../src/ui/menu.js';

describe('modal keyboard focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    // JSDOM has no layout; give visible controls a rendered rectangle.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
    document.body.replaceChildren(el('div', { id: 'app' }, el('button', {}, 'Open')));
    document.querySelector('#app button').focus();
  });
  afterEach(() => {
    closeMenu();
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function tab(shiftKey = false) {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event;
  }

  it('lets Tab move on from a collapsible section\'s summary, as from any other control', () => {
    const summary = el('summary', {}, 'More options'), ok = el('button', { type: 'button' }, 'Insert');
    openModal({ title: 'Equation', content: el('div', {}, el('input', { 'aria-label': 'Equation' }), el('details', {}, summary, el('p', {}, 'Choices')), el('button', { type: 'button' }, 'Cancel'), ok) });
    summary.focus();
    // The browser moves focus to Cancel; the dialog must not pull it back to its first control.
    expect(tab().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(summary);
    ok.focus();
    expect(tab().defaultPrevented).toBe(true);
  });

  it('opens a dialog on the chosen option of a group of choices, not the first one', async () => {
    const { segmented } = await import('../src/ui/segmented.js');
    const choices = segmented([['header', 'Header'], ['footer', 'Footer']], 'footer', () => {}, 'Position');
    formDialog({ title: 'Page numbers', fields: [], extra: el('div.field', {}, el('span.field-label', {}, 'Position'), choices) });
    const active = document.activeElement;
    expect(active.textContent).toBe('Footer');
    expect(active.getAttribute('aria-checked')).toBe('true');
  });

  it.each(['success', 'failure'])('aborts a pending form and ignores late %s without changing the replacement dialog', async (outcome) => {
    let finish;
    const prepare = vi.fn(() => new Promise((resolve, reject) => { finish = outcome === 'success' ? resolve : reject; }));
    const result = formDialog({ title: 'Format', fields: [{ name: 'amount', label: 'Amount', value: 2, type: 'number' }], prepare });
    document.querySelector('.modal-panel form').requestSubmit();
    const signal = prepare.mock.calls[0][1].signal;
    document.querySelector('[aria-label="Close"]').click();
    await expect(result).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
    const input = el('input', { value: 'New dialog' });
    const replacement = openModal({ title: 'Replacement', content: input });
    finish(outcome === 'success' ? undefined : new Error('Late failure'));
    await vi.advanceTimersByTimeAsync(250);
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('.modal-panel')).toHaveLength(1);
    expect(replacement.panel.textContent).not.toContain('Late failure');
  });

  it('restores existing disabled states after a failed form preparation', async () => {
    const disabled = el('input', { disabled: true, value: 'Unavailable setting' });
    const choice = el('select', {}, el('option', { value: 'auto' }, 'Automatic'));
    const prepare = vi.fn().mockRejectedValueOnce(new Error('Try later')).mockResolvedValueOnce();
    const result = formDialog({ title: 'Format', fields: [{ name: 'amount', label: 'Amount', value: 2, type: 'number' }], extra: el('div', {}, disabled, choice), prepare });
    const form = document.querySelector('.modal-panel form');
    form.requestSubmit();
    expect(choice.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(disabled.disabled).toBe(true);
    expect(choice.disabled).toBe(false);
    expect(form.querySelector('[role="alert"]').textContent).toBe('Try later');
    form.requestSubmit();
    await expect(result).resolves.toEqual({ amount: 2 });
  });

  it.each(['success', 'failure'])('cancels a pending prompt and ignores its late %s', async (outcome) => {
    let complete;
    const prepare = vi.fn(() => new Promise((resolve, reject) => { complete = outcome === 'success' ? resolve : reject; }));
    const result = promptDialog({ title: 'Picture', label: 'Address', value: 'https://example.com/photo.png', prepare, pendingLabel: 'Fetching picture…' });
    const form = document.querySelector('.modal-panel form');
    form.requestSubmit();
    form.requestSubmit();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(form.querySelector('input').disabled).toBe(true);
    expect(form.querySelector('[type="submit"]').textContent).toBe('Fetching picture…');
    const signal = prepare.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    document.querySelector('[aria-label="Close"]').click();
    await expect(result).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
    complete(new Error('Late failure'));
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector('.modal-root')).toBeNull();
    expect(form.querySelector('[role="alert"]').hidden).toBe(true);
  });

  it('focuses an available control instead of hidden or disabled fields on open', () => {
    const ready = el('button', {}, 'Continue');
    openModal({ title: 'Loading', content: el('div', {},
      el('textarea', { hidden: true }), el('input', { disabled: true }),
      el('fieldset', { disabled: true }, el('input')), ready) });
    expect(document.activeElement).toBe(ready);
  });

  it('focuses the dialog while its content controls are unavailable', () => {
    const { panel } = openModal({ title: 'Thinking', content: el('div', {},
      el('textarea', { hidden: true }), el('button', { disabled: true }, 'Copy')) });
    expect(document.activeElement).toBe(panel);
  });

  it('wraps Tab and Shift+Tab within the active dialog, skipping disabled and hidden controls', () => {
    const input = el('input');
    const last = el('button', {}, 'Save');
    const { panel } = openModal({ title: 'Edit', content: el('div', {}, input, last, el('button', { disabled: true }, 'Disabled'), el('div', { hidden: true }, el('button', {}, 'Hidden'))) });
    const first = panel.querySelector('[aria-label="Close"]');
    last.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement === first).toBe(true);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement === last).toBe(true);
    input.focus();
    expect(tab().defaultPrevented).toBe(false);
    panel.focus();
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement === last).toBe(true);
  });

  it('traps only the top dialog and returns focus to the underlying dialog on close', () => {
    const opener = el('button', {}, 'Open details');
    const outer = openModal({ title: 'Outer', content: opener });
    opener.focus();
    const last = el('button', {}, 'Done');
    const inner = openModal({ title: 'Inner', content: last });
    last.focus();
    tab();
    expect(document.activeElement === inner.panel.querySelector('[aria-label="Close"]')).toBe(true);
    inner.close();
    vi.advanceTimersByTime(200);
    expect(document.activeElement === opener).toBe(true);
    expect(outer.panel.closest('[inert]')).toBeNull();
  });

  it('keeps focus on the panel if all its controls are disabled', () => {
    const { panel } = openModal({ title: 'Working', content: el('p', {}, 'Please wait') });
    panel.querySelector('button').disabled = true;
    panel.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement === panel).toBe(true);
  });

  it('restores the original opener after replacing a closing dialog', () => {
    // Model the browser's inert focus behavior, which JSDOM does not enforce.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (...args) {
      if (!this.closest('[inert]')) focus.apply(this, args);
    });
    const opener = el('button', {}, 'Open details');
    openModal({ title: 'Outer', content: opener });
    opener.focus();
    const first = openModal({ title: 'First', content: el('input') });
    first.close();
    const input = el('input');
    const replacement = openModal({ title: 'Replacement', content: input });
    expect(document.activeElement).toBe(input);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
    replacement.close();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(opener);
  });

  it('lets the page take focus as soon as a dialog closes, and otherwise returns it to the opener', () => {
    // Model the browser's inert focus behavior, which JSDOM does not enforce.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (...args) {
      if (!this.closest('[inert]')) focus.apply(this, args);
    });
    const app = document.getElementById('app');
    const opener = app.querySelector('button');
    const page = el('div', { tabindex: -1 }, 'Document');
    app.append(page);
    const modal = openModal({ title: 'Paragraph spacing', content: el('input') });
    expect(app.hasAttribute('inert')).toBe(true);
    modal.close();
    // The view puts the caret back in the document right after Apply.
    expect(app.hasAttribute('inert')).toBe(false);
    page.focus();
    expect(document.activeElement).toBe(page);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(page);
    expect(document.body.classList.contains('modal-open')).toBe(false);

    // Nothing claimed focus: it goes back to the button that opened the dialog.
    opener.focus();
    const second = openModal({ title: 'Rename', content: el('input') });
    second.close();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(opener);
  });

  it('closes a dialog color palette on Escape without discarding the dialog', () => {
    const input = el('input', { value: 'Unapplied changes' });
    const anchor = el('button', {}, 'Line color');
    const onClose = vi.fn();
    const modal = openModal({ title: 'Borders and shading', content: el('div', {}, input, anchor), onClose });
    anchor.focus();
    openColorMenu({ anchor, colors: ['#000000', '#ffffff'], onPick: vi.fn() });
    const escape = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    escape();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(modal.panel.closest('.closing')).toBeNull();
    expect(input.value).toBe('Unapplied changes');
    expect(document.activeElement).toBe(anchor);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets a press on the scrim dismiss a dialog palette without discarding the dialog', () => {
    const input = el('input', { value: 'Unapplied changes' });
    const anchor = el('button', {}, 'Line color');
    const onClose = vi.fn();
    const modal = openModal({ title: 'Borders and shading', content: el('div', {}, input, anchor), onClose });
    anchor.focus();
    openColorMenu({ anchor, colors: ['#000000', '#ffffff'], onPick: vi.fn() });
    const scrim = document.querySelector('.modal-scrim');
    // The press closes the palette; the click the same press ends with lands on the scrim.
    scrim.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(modal.panel.closest('.closing')).toBeNull();
    expect(input.value).toBe('Unapplied changes');
    // A later click on the scrim is a gesture of its own and closes the dialog as always.
    vi.advanceTimersByTime(700);
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('tabs through custom color controls (shift=%s), then returns to its dialog', (shiftKey) => {
    const anchor = el('button', {}, 'Line color');
    const onClose = vi.fn();
    openModal({ title: 'Borders and shading', content: anchor, onClose });
    anchor.focus();
    openColorMenu({ anchor, colors: ['#000000', '#ffffff'], onPick: vi.fn() });
    const menu = document.querySelector('[role="menu"]');
    menu.querySelector('input[type="color"]').focus();
    if (!shiftKey) {
      tab();
      expect(document.activeElement).toBe(menu.querySelector('input[type="text"]'));
      tab();
      expect(document.activeElement).toBe(menu.querySelector('button[type="submit"]'));
      expect(menu.isConnected).toBe(true);
    }
    expect(tab(shiftKey).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  });
});

it('hands an emptied number field to the validator as not a number, not as zero', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }));
  const seen = [];
  const pending = formDialog({ title: 'Size', fields: [{ name: 'width', label: 'Width', type: 'number', value: 3 }], validate: (v) => { seen.push(v.width); return Number.isFinite(v.width) ? null : 'Enter a width'; } });
  const form = document.querySelector('.modal-panel form');
  form.querySelector('input[type="number"]').value = '';
  form.requestSubmit();
  expect(seen).toEqual([NaN]);
  expect(document.querySelector('.modal-panel .field-error').textContent).toBe('Enter a width');
  form.querySelector('input[type="number"]').value = '4';
  form.requestSubmit();
  expect(await pending).toEqual({ width: 4 });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('dialog field descriptions', () => {
  it('describes a prompt field by its hint and, once shown, its error', async () => {
    const { promptDialog } = await import('../src/ui/modal.js');
    document.body.innerHTML = '<div id="app"></div>';
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    const pending = promptDialog({ title: 'Rename', label: 'Name', hint: 'Letters and numbers', validate: (v) => (v === 'bad' ? 'Not that' : null) });
    const input = document.querySelector('.modal-panel input');
    const ids = input.getAttribute('aria-describedby').split(' ');
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]).textContent).toBe('Letters and numbers');
    expect(document.getElementById(ids[1]).getAttribute('role')).toBe('alert');
    input.value = 'bad';
    document.querySelector('.modal-panel form').requestSubmit();
    expect(document.getElementById(ids[1]).textContent).toBe('Not that');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    document.querySelector('.modal-root .btn-ghost').click();
    expect(await pending).toBeNull();
  });

  it('describes every form field by its hint and the shared error, and marks them invalid together', async () => {
    const { formDialog } = await import('../src/ui/modal.js');
    document.body.innerHTML = '<div id="app"></div>';
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    const pending = formDialog({ title: 'Spacing', fields: [{ name: 'before', label: 'Before', type: 'number', hint: 'In points' }, { name: 'after', label: 'After', type: 'number' }], validate: () => 'Use numbers' });
    const [before, after] = document.querySelectorAll('.modal-panel input');
    const error = document.querySelector('.modal-panel .field-error');
    expect(before.getAttribute('aria-describedby').split(' ')).toEqual([document.querySelector('.modal-panel .field-hint').id, error.id]);
    expect(after.getAttribute('aria-describedby')).toBe(error.id);
    document.querySelector('.modal-panel form').requestSubmit();
    expect([before, after].map((i) => i.getAttribute('aria-invalid'))).toEqual(['true', 'true']);
    document.querySelector('.modal-root .btn-ghost').click();
    expect(await pending).toBeNull();
  });
});
