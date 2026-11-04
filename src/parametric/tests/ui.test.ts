// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMenus, openMenu } from '../src/ui/menu';
import { confirmDialog, promptDialog, toast } from '../src/ui/overlay';
import { numberField, parseParam, paramText, type UnitContext } from '../src/app/pm';

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
});
