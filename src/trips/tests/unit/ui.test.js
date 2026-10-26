import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { el, safeURL } from '../../src/ui/dom.js';
import { markdown } from '../../src/ui/md.js';
import { button, emptyState } from '../../src/ui/bits.js';
import { field, segmented } from '../../src/ui/fields.js';
import { tabs } from '../../src/ui/tabs.js';
import { openModal, confirmDialog, promptDialog } from '../../src/ui/modal.js';
import { openMenu } from '../../src/ui/menu.js';
import { dateRangePicker } from '../../src/ui/dates.js';
import { avatar } from '../../src/ui/avatar.js';
import { makeDragSource, makeDropZone, makeSortable } from '../../src/ui/dnd.js';
import { virtualList } from '../../src/ui/vlist.js';
import { toast } from '../../src/ui/toast.js';
import { applyTheme, currentTheme, onThemeChange } from '../../src/ui/theme.js';
const key = (target, value, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
const dialogs = [];
beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => {
  for (const dialog of dialogs.splice(0).reverse()) dialog.close();
  vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); delete document.documentElement.dataset.theme;
});
describe('safe content', () => {
  it('keeps untrusted text inert and preserves false ARIA values', () => {
    const node = el('div.card', { 'aria-busy': false }, ['<img src=x onerror=alert(1)>', [0, false, null]]);
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>0'); expect(node.children).toHaveLength(0);
    expect(node.getAttribute('aria-busy')).toBe('false');
    expect(() => el('div', { html: '<b>x</b>' })).toThrow(); expect(() => el('img', { onerror: 'alert(1)' })).toThrow();
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.test', '/relative', '\u0000javascript:alert(1)', 'https://bank.example@evil.test/', '', undefined])('rejects unsafe URL %s', (url) => expect(safeURL(url)).toBeNull());
  it('emits only safe Markdown tags and HTTP links', () => {
    const node = markdown('# Heading\n**Bold** and *italic* with `code`\n\n- [safe](https://example.com)\n- [bad](javascript:alert)\n\n<img src=x onerror=alert(1)>\n```html\n<script>alert(1)</script>\n```');
    expect(node.querySelector('h1').textContent).toBe('Heading'); expect(node.querySelector('strong').textContent).toBe('Bold');
    expect(node.querySelectorAll('a')).toHaveLength(1); expect(node.querySelector('a').rel).toContain('noopener'); expect(node.querySelector('a').textContent).toBe('safe (example.com)');
    expect(markdown('[example.com](https://example.com/)').querySelector('a').textContent).toBe('example.com');
    expect(markdown('[https://bank.example@evil.test/](https://bank.example@evil.test/)').querySelector('a')).toBeNull();
    const spoofed = markdown('[\u202Emoc.knab](https://evil.test/)').querySelector('a');
    expect(spoofed.querySelector('bdi').textContent).toBe('\u202Emoc.knab'); expect(spoofed.querySelector('.link-host').dir).toBe('ltr');
    expect(node.querySelector('script,img,iframe,style')).toBeNull(); expect(node.textContent).toContain('<script>alert(1)</script>');
  });
  it('uses initials for unsafe avatar photos', () => {
    const node = avatar({ id: 'alice', name: '<img onerror=x>', photo: 'javascript:alert(1)' });
    expect(node.querySelector('img')).toBeNull(); expect(node.getAttribute('aria-label')).toBe('<img onerror=x>');
    expect(avatar({ name: 'Bob', presence: 'kit.title' }).getAttribute('aria-label')).toBe('Bob');
  });
});
describe('fields and tabs', () => {
  it('links labels, hints and errors and clears custom validity', () => {
    const control = field({ label: 'Name', hint: 'Required', error: 'Enter name' }); document.body.append(control.element);
    expect(control.element.querySelector('label').htmlFor).toBe(control.input.id); expect(control.input.validity.valid).toBe(false);
    const errorId = control.input.getAttribute('aria-describedby').split(' ')[1]; expect(document.getElementById(errorId).textContent).toBe('Enter name');
    control.setError(''); expect(control.input.validity.valid).toBe(true); expect(control.input.getAttribute('aria-invalid')).toBe('false');
  });
  it('renders the empty-state title at the requested heading level or as plain text', () => {
    expect(emptyState({ title: 'None' }).querySelector('.empty-title').tagName).toBe('H3');
    expect(emptyState({ title: 'None', level: 2 }).querySelector('.empty-title').tagName).toBe('H2');
    const plain = emptyState({ title: 'None', level: 0 }).querySelector('.empty-title');
    expect(plain.tagName).toBe('P'); expect(plain.textContent).toBe('None');
  });
  it('busy buttons retain focus but block activation', () => {
    const clicked = vi.fn(); const node = button('Save', { busy: true, onclick: clicked }); document.body.append(node); node.focus(); node.click();
    expect(document.activeElement).toBe(node); expect(clicked).not.toHaveBeenCalled();
  });
  it('moves segmented selection with arrows and skips disabled choices', () => {
    const onChange = vi.fn(); const control = segmented({ label: 'View', onChange, items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }] });
    document.body.append(control.element); const nodes = control.element.querySelectorAll('button'); nodes[0].focus(); key(nodes[0], 'ArrowRight');
    expect(document.activeElement).toBe(nodes[2]); expect(control.value).toBe('c'); expect(onChange).toHaveBeenCalledWith('c');
  });
  it('keeps aria-checked on radio segments when every choice is disabled', () => {
    const control = segmented({ label: 'Kind', radio: true, value: 'b', items: [{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B', disabled: true }] });
    expect([...control.element.querySelectorAll('[role=radio]')].map((node) => node.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(control.value).toBe('b');
  });
  it('links tabs to panels and selects with Home/End', () => {
    const control = tabs({ label: 'Trip', items: [{ id: 'a', label: 'A', content: 'Alpha' }, { id: 'b', label: 'B', content: 'Beta' }] }); document.body.append(control.element);
    const nodes = control.element.querySelectorAll('[role=tab]'); nodes[0].focus(); key(nodes[0], 'End'); expect(control.value).toBe('b');
    expect(document.getElementById(nodes[0].getAttribute('aria-controls')).hidden).toBe(true); key(nodes[1], 'Home'); expect(control.value).toBe('a');
  });
});
describe('overlays', () => {
  it('inerts the background, wraps focus, dismisses and returns focus', () => {
    const opener = button('Open'); document.body.append(opener); opener.focus(); const a = button('First'); const b = button('Last');
    const dialog = openModal({ title: 'Test', content: el('div', {}, a, b) }); dialogs.push(dialog); expect(opener.inert).toBe(true);
    b.focus(); key(b, 'Tab'); expect(document.activeElement.getAttribute('aria-label')).toBe('Close');
    key(document.activeElement, 'Tab', { shiftKey: true }); expect(document.activeElement).toBe(b);
    key(b, 'Escape'); expect(dialog.root.isConnected).toBe(false); expect(document.activeElement).toBe(opener); expect(Boolean(opener.inert)).toBe(false);
  });
  it('inerts lower dialogs and preserves existing inert state', async () => {
    const background = el('div'); background.inert = true; document.body.append(background);
    const nested = button('Nested'); const first = openModal({ title: 'One', content: nested }); dialogs.push(first); nested.focus();
    const second = openModal({ title: 'Two', content: button('Inner') }); dialogs.push(second); expect(first.root.inert).toBe(true);
    second.close(); expect(first.root.inert).toBe(false); expect(document.activeElement).toBe(nested);
    const late = el('aside'); document.body.append(late); await Promise.resolve(); expect(late.inert).toBe(true);
    first.close(); expect(background.inert).toBe(true); expect(Boolean(late.inert)).toBe(false);
  });
  it('skips hidden and disabled fields when choosing initial focus', () => {
    const visible = el('input');
    const dialog = openModal({ title: 'Fields', content: el('div', {}, el('input', { type: 'hidden' }), el('input', { disabled: true }), visible) }); dialogs.push(dialog);
    expect(document.activeElement).toBe(visible);
  });
  it('keeps focus in the top dialog when a lower dialog closes', () => {
    const first = openModal({ title: 'One', content: 'One' }); dialogs.push(first); const second = openModal({ title: 'Two', content: 'Two' }); dialogs.push(second);
    first.close(); expect(second.panel.contains(document.activeElement)).toBe(true);
  });
  it('resolves confirmation and prompt results', async () => {
    const confirmed = confirmDialog({ title: 'Delete?', body: 'Delete item' }); [...document.querySelectorAll('.modal-actions button')].at(-1).click(); expect(await confirmed).toBe(true);
    const prompted = promptDialog({ title: 'Name', label: 'Name', value: 'Trip' }); document.querySelector('.modal-body form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); expect(await prompted).toBe('Trip');
  });
  it('supports menu navigation, disabled items, checkbox callbacks and focus return', () => {
    const anchor = button('Menu'); document.body.append(anchor); const onSelect = vi.fn();
    const menu = openMenu(anchor, [{ label: 'A' }, { label: 'Disabled', disabled: true }, { label: 'Check', checked: false, onSelect }]);
    expect(anchor.getAttribute('aria-expanded')).toBe('true'); key(document.activeElement, 'ArrowDown'); expect(document.activeElement.textContent).toBe('Check');
    document.activeElement.click(); expect(onSelect).toHaveBeenCalledWith(true); expect(document.activeElement).toBe(anchor); expect(menu.element.isConnected).toBe(false);
  });
  it('follows its anchor when the page shifts and closes once the anchor leaves the screen', () => {
    const anchor = button('Menu'); document.body.append(anchor);
    let top = 100;
    anchor.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 20, right: 60, width: 40, height: 30 });
    const menu = openMenu(anchor, [{ label: 'One' }]);
    expect(menu.element.style.top).toBe('134px');
    top = 160; document.dispatchEvent(new Event('scroll'));
    expect(menu.element.isConnected).toBe(true); expect(menu.element.style.top).toBe('194px');
    top = -60; document.dispatchEvent(new Event('scroll'));
    expect(menu.element.isConnected).toBe(false);
  });
  it('stays open in place when a re-render replaces its anchor', () => {
    const anchor = button('Menu'); document.body.append(anchor); const onSelect = vi.fn();
    anchor.getBoundingClientRect = () => ({ top: 100, bottom: 130, left: 20, right: 60, width: 40, height: 30 });
    const menu = openMenu(anchor, [{ label: 'One', onSelect }]);
    anchor.replaceWith(button('Menu'));
    document.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
    expect(menu.element.isConnected).toBe(true); expect(menu.element.style.top).toBe('134px');
    menu.element.querySelector('[role=menuitem]').click();
    expect(onSelect).toHaveBeenCalledOnce(); expect(menu.element.isConnected).toBe(false);
  });
  it('dismisses an inner menu without dismissing the dialog', () => {
    const anchor = button('Menu'); const dialog = openModal({ title: 'Dialog', content: anchor }); dialogs.push(dialog);
    const menu = openMenu(anchor, [{ label: 'One' }]); key(document.activeElement, 'Escape');
    expect(menu.element.isConnected).toBe(false); expect(dialog.root.isConnected).toBe(true); expect(document.activeElement).toBe(anchor);
  });
  it('closes a dialog-owned menu and removes its global listeners', () => {
    const anchor = button('Menu'); const dialog = openModal({ title: 'Dialog', content: anchor }); dialogs.push(dialog);
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const menu = openMenu(anchor, [{ label: 'One' }]);
    dialog.close();
    expect(menu.element.isConnected).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    expect(anchor.hasAttribute('aria-controls')).toBe(false);
    expect(removeDocumentListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    const mutateOldAnchor = vi.spyOn(anchor, 'setAttribute');
    const nextAnchor = button('Next'); document.body.append(nextAnchor);
    const nextMenu = openMenu(nextAnchor, [{ label: 'Two' }]);
    expect(mutateOldAnchor).not.toHaveBeenCalled(); nextMenu.close();
  });
  it('keeps toast actions and announcements in the active modal focus scope', async () => {
    const opener = button('Open'); document.body.append(opener); opener.focus();
    const dialog = openModal({ title: 'Dialog', content: 'Content' }); dialogs.push(dialog);
    const onClick = vi.fn(); const notification = toast('Try again', { duration: 0, action: { label: 'Retry', onClick } });
    await Promise.resolve();
    expect(dialog.panel.contains(notification.element)).toBe(true);
    for (let node = notification.element; node; node = node.parentElement) expect(Boolean(node.inert)).toBe(false);
    const action = notification.element.querySelector('.toast-action'); action.focus(); expect(document.activeElement).toBe(action);
    const nested = openModal({ title: 'Nested', content: 'Content' }); dialogs.push(nested);
    expect(nested.panel.contains(notification.element)).toBe(true);
    nested.close(); expect(dialog.panel.contains(notification.element)).toBe(true);
    dialog.close(); expect(notification.element.isConnected).toBe(true);
    expect(document.activeElement).toBe(opener); action.focus(); expect(document.activeElement).toBe(action);
    action.click(); expect(onClick).toHaveBeenCalledOnce();
  });
  it('keeps expiry paused when pointer leave occurs while the action is focused', () => {
    vi.useFakeTimers(); const notification = toast('Saved', { duration: 100, action: { label: 'Undo', onClick: vi.fn() } });
    const action = notification.element.querySelector('.toast-action');
    notification.element.dispatchEvent(new Event('pointerenter')); action.focus();
    notification.element.dispatchEvent(new Event('pointerleave')); vi.advanceTimersByTime(200);
    expect(notification.element.isConnected).toBe(true);
    action.blur(); vi.advanceTimersByTime(100); expect(notification.element.isConnected).toBe(false);
  });
  it('keeps expiry paused when focus leaves a hovered toast', () => {
    vi.useFakeTimers(); const notification = toast('Saved', { duration: 100, action: { label: 'Undo', onClick: vi.fn() } });
    const action = notification.element.querySelector('.toast-action'); action.focus();
    notification.element.dispatchEvent(new Event('pointerenter')); action.blur(); vi.advanceTimersByTime(200);
    expect(notification.element.isConnected).toBe(true);
    notification.element.dispatchEvent(new Event('pointerleave')); vi.advanceTimersByTime(100); expect(notification.element.isConnected).toBe(false);
  });
  it('pauses toast expiry during focus and cleans up after an action', () => {
    vi.useFakeTimers(); const onClick = vi.fn(); const notification = toast('Saved', { action: { label: 'Undo', onClick }, duration: 100 });
    notification.element.querySelector('button').focus(); vi.advanceTimersByTime(200); expect(notification.element.isConnected).toBe(true);
    notification.element.querySelector('button').click(); expect(onClick).toHaveBeenCalledOnce(); expect(document.querySelector('.toast-root')).toBeNull();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(() => notification.close()).not.toThrow();
  });
});
describe('dates and lists', () => {
  it.each([
    ['America/Vancouver', '2026-11-01T01:00:00Z', 'October 2026', '2026-10-31'],
    ['Pacific/Kiritimati', '2026-10-31T12:00:00Z', 'November 2026', '2026-11-01'],
  ])('seeds the month, today marker and tab stop from local dates in %s', (zone, time, month, date) => {
    const previousZone = process.env.TZ;
    process.env.TZ = zone;
    vi.useFakeTimers(); vi.setSystemTime(new Date(time));
    try {
      const range = dateRangePicker(); document.body.append(range.element);
      expect(range.element.querySelector('.mini-head h3').textContent).toBe(month);
      const today = range.element.querySelector('[aria-current="date"]');
      expect(today.dataset.date).toBe(date); expect(today.tabIndex).toBe(0);
      range.setValue({ start: '', end: '' });
      expect(range.element.querySelector('.mini-head h3').textContent).toBe(month);
    } finally {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    }
  });
  it('validates reversed native ranges and recovers', () => {
    const onChange = vi.fn(); const range = dateRangePicker({ start: '2026-12-30', end: '2027-01-02', onChange }); document.body.append(range.element);
    range.endInput.value = '2026-12-29'; range.endInput.dispatchEvent(new Event('change')); expect(range.endInput.validity.valid).toBe(false); expect(onChange).not.toHaveBeenCalled();
    range.endInput.value = '2027-01-03'; range.endInput.dispatchEvent(new Event('change')); expect(range.endInput.validity.valid).toBe(true); expect(onChange).toHaveBeenCalledWith({ start: '2026-12-30', end: '2027-01-03' });
  });
  it('moves calendar focus across the year boundary and selects a range', () => {
    const range = dateRangePicker({ start: '2026-12-31', end: '' }); document.body.append(range.element);
    const day = range.element.querySelector('[data-date="2026-12-31"]'); day.focus(); key(day, 'ArrowRight');
    expect(document.activeElement.dataset.date).toBe('2027-01-01'); document.activeElement.click(); expect(range.value).toEqual({ start: '2026-12-31', end: '2027-01-01' });
  });
  it('honors min and max dates for keyboard navigation', () => {
    const range = dateRangePicker({ start: '2026-11-09', min: '2026-11-09', max: '2026-11-13' }); document.body.append(range.element);
    const day = range.element.querySelector('[data-date="2026-11-09"]'); day.focus(); key(day, 'ArrowLeft');
    expect(document.activeElement).toBe(day); expect(range.element.querySelector('[data-date="2026-11-14"]').disabled).toBe(true);
  });
  it('provides Alt+Arrow reordering, a live announcement and teardown', () => {
    const onMove = vi.fn(); const list = el('div', {}, ['A', 'B', 'C'].map((name) => el('div', { dataset: { sortableItem: name, label: name } }, el('button', { dataset: { sortableHandle: '' } }, name)))); document.body.append(list);
    const sortable = makeSortable(list, { onMove }); const handle = list.querySelector('button'); handle.focus(); key(handle, 'ArrowDown', { altKey: true });
    expect([...list.querySelectorAll('[data-sortable-item]')].map((node) => node.dataset.label)).toEqual(['B', 'A', 'C']); expect(document.activeElement).toBe(handle);
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ from: 0, to: 1 })); expect(list.querySelector('[role=status]').textContent).toContain('position 2 of 3');
    sortable.destroy(); expect(handle.hasAttribute('aria-describedby')).toBe(false);
  });
  it('drags between lists into a drop zone and reports keyboard moves', () => {
    const row = (name) => el('li', { dataset: { item: name } }, el('button', { dataset: { dragHandle: '' } }, name));
    const from = el('ol', {}, row('A'), row('B')); const to = el('ol', {}, row('X'), row('Y')); document.body.append(from, to);
    const onDrop = vi.fn(); const onKey = vi.fn();
    const source = makeDragSource(from, { itemSelector: '[data-item]', data: (item) => item.dataset.item, onKey });
    const zone = makeDropZone(to, { itemSelector: '[data-item]', accepts: (data) => data !== 'B', onDrop });
    const y = to.children[1];
    y.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, width: 100 });
    document.elementFromPoint = () => y;
    const pointer = (type, target, x, yy) => target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: yy, button: 0 }), { pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
    const grip = from.querySelector('button');
    pointer('pointerdown', grip, 0, 0); pointer('pointermove', document, 0, 130);
    expect(to.querySelector('.card-placeholder')).toBe(y.nextSibling);
    pointer('pointerup', document, 0, 130);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ data: 'A', index: 2 }));
    expect(document.querySelector('.card-placeholder, .drag-ghost')).toBeNull();
    key(grip, 'ArrowDown', { altKey: true });
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ data: 'A', delta: 1 }));
    source.destroy(); zone.destroy(); delete document.elementFromPoint;
  });
  it('puts the drop slot back at the origin when the pointer leaves every list, and drops nothing there', () => {
    const row = (name) => el('li', { dataset: { item: name } }, el('button', { dataset: { dragHandle: '' } }, name));
    const list = el('ol', {}, row('A'), row('B'), row('C')); const outside = el('div'); document.body.append(list, outside);
    const onDrop = vi.fn();
    const source = makeDragSource(list, { itemSelector: '[data-item]', data: (item) => item.dataset.item });
    const zone = makeDropZone(list, { itemSelector: '[data-item]', onDrop });
    const [a, , c] = list.children;
    c.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, width: 100 });
    let under = c;
    document.elementFromPoint = () => under;
    const pointer = (type, target, yy) => target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: yy, button: 0 }), { pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
    pointer('pointerdown', a.querySelector('button'), 0); pointer('pointermove', document, 130);
    expect(a.classList.contains('dnd-hidden')).toBe(true);
    expect(c.nextSibling?.classList.contains('card-placeholder')).toBe(true);
    under = outside; pointer('pointermove', document, 300);
    expect(a.previousSibling?.classList.contains('card-placeholder')).toBe(true);
    expect(list.querySelectorAll('.card-placeholder')).toHaveLength(1);
    pointer('pointerup', document, 300);
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector('.card-placeholder')).toBeNull();
    source.destroy(); zone.destroy(); delete document.elementFromPoint;
  });
  it('bounds rendered virtual rows, reaches the end and updates empty lists', () => {
    const list = virtualList({ items: Array.from({ length: 1000 }, (_, n) => n), renderItem: String, rowHeight: 40, height: 200 }); document.body.append(list.element);
    expect(list.element.querySelectorAll('[role=listitem]').length).toBeLessThan(15); list.scrollToIndex(999); expect(list.element.textContent).toContain('999');
    expect(list.element.querySelector('[aria-posinset="1000"]').getAttribute('aria-setsize')).toBe('1000'); list.setItems([]); expect(list.element.textContent).toBe(''); list.destroy(); expect(list.element.isConnected).toBe(false);
  });
  it('applies themes and tolerates blocked storage', () => {
    const listener = vi.fn(); const off = onThemeChange(listener); applyTheme('dark'); expect(currentTheme()).toBe('dark'); applyTheme('system'); expect(currentTheme()).toBe('system'); expect(listener).toHaveBeenCalledTimes(2); off();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); }); expect(() => applyTheme('light')).not.toThrow(); storage.mockRestore();
  });
});
