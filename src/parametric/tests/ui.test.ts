// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMenus, openMenu } from '../src/ui/menu';
import { attachTooltip, confirmDialog, dialogOpen, promptDialog, showDialog, toast } from '../src/ui/overlay';
import { numberField, parseParam, paramText, retireNumberFields, type UnitContext } from '../src/app/pm';
import { Selection } from '../src/app/selection';

const ctx = (units: UnitContext['units'] = 'MMGS'): UnitContext => ({ units, decimals: 2, variables: () => new Map([['Len', 4]]) });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

afterEach(() => {
  closeMenus();
  document.body.innerHTML = '';
});

describe('menus', () => {
  it('opens with roles, navigates with arrows and runs items', () => {
    const run = vi.fn();
    const menu = openMenu([
      { label: 'First', run },
      { label: 'Disabled', disabled: true },
      { separator: true },
      { label: 'Third', run },
    ], 10, 10);
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0]);
    key(menu, 'ArrowDown');
    // The disabled item is skipped.
    expect(document.activeElement).toBe(items[2]);
    items[2].click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.menu')).toBeNull();
  });

  it('closes on Escape and supports type-ahead', () => {
    const menu = openMenu([{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }], 0, 0);
    key(menu, 'g');
    expect((document.activeElement as HTMLElement).textContent).toContain('Gamma');
    key(menu, 'Escape');
    expect(document.querySelector('.menu')).toBeNull();
  });
});

describe('menu focus', () => {
  it('returns focus to the opener after running an item, also from a submenu', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const run = vi.fn(() => document.activeElement);
    const menu = openMenu([{ label: 'Item', run }, { label: 'More', submenu: () => [{ label: 'Deep', run }] }], 0, 0);
    (menu.querySelector('[role="menuitem"]') as HTMLElement).click();
    expect(run).toHaveLastReturnedWith(opener);
    const menu2 = openMenu([{ label: 'More', submenu: () => [{ label: 'Deep', run }] }], 0, 0);
    (menu2.querySelector('[role="menuitem"]') as HTMLElement).click();
    const deep = [...document.querySelectorAll('.menu')][1].querySelector('[role="menuitem"]') as HTMLElement;
    expect(document.activeElement).toBe(deep);
    deep.click();
    expect(document.querySelector('.menu')).toBeNull();
    expect(run).toHaveLastReturnedWith(opener);
  });
});

describe('tooltips', () => {
  it('do not appear or linger for a control that was removed', () => {
    vi.useFakeTimers();
    try {
      const a = document.createElement('button');
      const b = document.createElement('button');
      document.body.append(a, b);
      attachTooltip(a, 'A');
      attachTooltip(b, 'B');
      a.dispatchEvent(new Event('pointerenter'));
      a.remove();
      vi.advanceTimersByTime(1000);
      expect(document.querySelector('.tooltip')).toBeNull();
      b.dispatchEvent(new Event('pointerenter'));
      vi.advanceTimersByTime(1000);
      expect(document.querySelector('.tooltip')?.textContent).toBe('B');
      b.remove();
      document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
      expect(document.querySelector('.tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dialogs and toasts', () => {
  it('resolves confirm dialogs and closes on Escape', async () => {
    const p = confirmDialog('Delete', 'Really?', 'Delete', true);
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    (dlg.querySelector('[data-value="ok"]') as HTMLButtonElement).click();
    expect(await p).toBe(true);
    const p2 = confirmDialog('Delete', 'Really?');
    key(document.querySelector('[role="dialog"]')!, 'Escape');
    expect(await p2).toBe(false);
  });

  it('puts focus inside destructive confirmations, on the safe button', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const p = confirmDialog('Delete', 'Really?', 'Delete', true);
    await new Promise((r) => requestAnimationFrame(r));
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
    key(document.activeElement!, 'Escape');
    expect(await p).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('validates prompt input', async () => {
    const p = promptDialog('Name', 'Name', 'abc', (v) => (v.length < 2 ? 'Too short' : null));
    const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    input.value = 'x';
    (document.querySelector('[data-value="ok"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Too short');
    input.value = 'good';
    (document.querySelector('[data-value="ok"]') as HTMLButtonElement).click();
    expect(await p).toBe('good');
  });

  it('shows dismissible toasts with actions', () => {
    const act = vi.fn();
    toast({ title: 'Hi', message: 'There', actions: [{ label: 'Do it', run: act }] });
    const t = document.querySelector('.toast')!;
    expect(t.getAttribute('role')).toBe('status');
    (t.querySelector('.actions button') as HTMLButtonElement).click();
    expect(act).toHaveBeenCalled();
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('keeps a timed toast while keyboard focus is in it', () => {
    vi.useFakeTimers();
    try {
      toast({ kind: 'error', message: 'Could not save', actions: [{ label: 'Download a copy', run: () => {} }], timeout: 1000 });
      const button = document.querySelector<HTMLButtonElement>('.toast .actions button')!;
      button.focus();
      vi.advanceTimersByTime(5000);
      expect(document.querySelector('.toast')).not.toBeNull();
      // Focus leaving the toast restarts a short timeout.
      button.blur();
      vi.advanceTimersByTime(2400);
      expect(document.querySelector('.toast')).not.toBeNull();
      vi.advanceTimersByTime(200);
      expect(document.querySelector('.toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PropertyManager number fields', () => {
  it('parses values in display units, with unit suffixes and expressions', () => {
    expect(parseParam('2', 'length', ctx('IPS'))).toMatchObject({ ok: true, value: 50.8 });
    expect(parseParam('10mm', 'length', ctx('IPS'))).toMatchObject({ ok: true, num: 10 });
    expect(parseParam('=Len*2', 'length', ctx())).toMatchObject({ ok: true, value: '=Len*2', num: 8 });
    expect(parseParam('=Len*2', 'length', ctx(), false)).toMatchObject({ ok: true, value: 8 });
    expect(parseParam('2.6', 'count', ctx())).toMatchObject({ ok: true, value: 3 });
    expect(parseParam('nope', 'length', ctx()).ok).toBe(false);
    expect(paramText(25.4, 'length', ctx('IPS'))).toBe('1');
    expect(paramText('=Len', 'length', ctx())).toBe('=Len');
  });

  it('commits on Enter, steps with arrow keys and flags invalid input', () => {
    const onChange = vi.fn();
    const el = numberField({ label: 'Depth', value: 10, kind: 'length', ctx: ctx(), min: 0, onChange });
    document.body.append(el);
    const input = el.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('Depth');
    key(input, 'ArrowUp');
    expect(onChange).toHaveBeenLastCalledWith(11);
    input.value = '-5';
    key(input, 'Enter');
    expect(input.classList.contains('invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = '=Len+1';
    key(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('=Len+1');
    expect(input.classList.contains('expr')).toBe(true);
  });

  it.each(['retired', 'removed'])('ignores delayed edits and change events from a %s numeric field', (state) => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const el = numberField({ label: 'Depth', value: 10, kind: 'length', ctx: ctx(), onChange });
      document.body.append(el);
      const input = el.querySelector('input')!;
      input.value = '40';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      if (state === 'retired') retireNumberFields(el);
      else el.remove();
      vi.advanceTimersByTime(500);
      expect(onChange).not.toHaveBeenCalled();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      expect(onChange).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('offers the full keyboard where minus signs, units or expressions can be typed', () => {
    const mode = (o: Partial<Parameters<typeof numberField>[0]>) => numberField({ label: 'X', value: 1, kind: 'length', ctx: ctx(), onChange: () => {}, ...o }).querySelector('input')!.getAttribute('inputmode');
    expect(mode({})).toBe('text');
    expect(mode({ min: 1e-6 })).toBe('text');
    expect(mode({ allowExpr: false })).toBe('text');
    expect(mode({ allowExpr: false, min: 3, kind: 'count' })).toBe('decimal');
    const input = numberField({ label: 'X', value: 1, kind: 'length', ctx: ctx(), onChange: () => {} }).querySelector('input')!;
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
  });

  it('takes back typed text on Escape, and passes Escape on when there is nothing to take back', () => {
    const onChange = vi.fn();
    const el = numberField({ label: 'Depth', value: 10, kind: 'length', ctx: ctx(), min: 0, onChange });
    document.body.append(el);
    const input = el.querySelector('input')!;
    const passed: boolean[] = [];
    const onKey = (e: KeyboardEvent) => passed.push(!e.defaultPrevented);
    window.addEventListener('keydown', onKey);
    input.focus();
    // Invalid text, not committed: Esc restores the value.
    input.value = 'abc';
    key(input, 'Enter', { cancelable: true });
    expect(input.classList.contains('invalid')).toBe(true);
    key(input, 'Escape', { cancelable: true });
    expect(input.value).toBe('10');
    expect(input.classList.contains('invalid')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // A committed edit since focus is taken back too.
    input.value = '25';
    key(input, 'Enter', { cancelable: true });
    expect(onChange).toHaveBeenLastCalledWith(25);
    key(input, 'Escape', { cancelable: true });
    expect(input.value).toBe('10');
    expect(onChange).toHaveBeenLastCalledWith(10);
    expect(passed).toEqual([true, false, true, false]);
    // Nothing left to take back: Esc goes on (to the panel, which it cancels).
    key(input, 'Escape', { cancelable: true });
    expect(passed.at(-1)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    window.removeEventListener('keydown', onKey);
  });
});

describe('selection', () => {
  it('tells listeners when only the hover changed', () => {
    const sel = new Selection();
    const calls: boolean[] = [];
    sel.on((hoverOnly) => calls.push(hoverOnly));
    sel.setHover({ kind: 'origin' });
    sel.setHover({ kind: 'origin' });
    sel.set([{ kind: 'feature', id: 'f1' }]);
    sel.setHover(null);
    expect(calls).toEqual([true, false, true]);
  });
});


describe('IME composition', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not submit or cancel a rename while choosing an IME candidate (%j)', async (init) => {
    const pending = promptDialog('Rename', 'Name', '部品');
    const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    key(input, 'Enter', init);
    await Promise.resolve();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    key(input, 'Escape', init);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    key(input, 'Enter');
    expect(await pending).toBe('部品');
  });

  it('does not change a numeric parameter with IME navigation or intermediate input', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const field = numberField({ label: 'Depth', value: 10, kind: 'length', ctx: ctx(), onChange });
      document.body.append(field);
      const input = field.querySelector('input')!;
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '20';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      vi.advanceTimersByTime(500);
      key(input, 'ArrowUp', { isComposing: true });
      key(input, 'Enter', { isComposing: true });
      key(input, 'Escape', { isComposing: true });
      expect(onChange).not.toHaveBeenCalled();
      expect(input.value).toBe('20');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      vi.advanceTimersByTime(500);
      expect(onChange).toHaveBeenCalledExactlyOnceWith(20);
    } finally { vi.useRealTimers(); }
  });
});


describe('dialog cancellation', () => {
  it('does not open an already cancelled dialog', async () => {
    const controller = new AbortController();
    controller.abort();
    const onReady = vi.fn();
    expect(await showDialog({ title: 'Stale', body: [], signal: controller.signal, onReady })).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(false);
  });

  it('cancels pending validation and restores focus without affecting another dialog', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const controller = new AbortController();
    let validate!: () => void;
    const gate = new Promise<void>((resolve) => { validate = resolve; });
    const pending = showDialog({ title: 'Old part', body: [], signal: controller.signal, onAction: () => gate });
    (document.querySelector('.dialog-foot button') as HTMLButtonElement).click();
    controller.abort();
    expect(await pending).toBeNull();
    expect(document.activeElement).toBe(opener);
    const next = showDialog({ title: 'New part', body: [] });
    validate();
    await Promise.resolve();
    expect(dialogOpen()).toBe(true);
    key(document.querySelector('[role="dialog"]')!, 'Escape');
    expect(await next).toBeNull();
    expect(dialogOpen()).toBe(false);
  });
});


it('rejects a confirmation cancelled immediately after its button was clicked', async () => {
  const controller = new AbortController();
  const pending = confirmDialog('Delete', 'Delete the old part?', 'Delete', true, controller.signal);
  (document.querySelector('.dialog-foot .danger') as HTMLButtonElement).click();
  controller.abort();
  expect(await pending).toBe(false);
  expect(dialogOpen()).toBe(false);
});

describe('editable parameter precision', () => {
  for (const units of ['MMGS', 'CGS', 'MKS', 'IPS'] as const) it(`preserves significant digits and small lengths in ${units}`, () => {
    for (const value of [30.123456789, 0.0004, 1e-8, -0.0004]) {
      const parsed = parseParam(paramText(value, 'length', ctx(units)), 'length', ctx(units));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(Math.abs(parsed.num - value)).toBeLessThanOrEqual(Math.abs(value) * 1e-14);
    }
  });
});
