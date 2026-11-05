// Shell review regressions: menus, dialogs, panels, storage and saving.
import { describe, it, expect, afterEach } from 'vitest';
import { openMenu, closeMenus, createMenubar } from '../src/ui/menu.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';

afterEach(() => {
  closeMenus();
  document.body.innerHTML = '';
});

const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('menu focus', () => {
  it('returns focus to where it was when a chord menu is closed with Escape', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&Place', items: [{ label: '&Wire', run: () => {} }] }]);
    canvas.focus();
    expect(bar.openByAccel('p')).toBe(true);
    expect(document.activeElement.classList.contains('menu-item')).toBe(true);
    key(document.activeElement, 'Escape');
    expect(document.querySelector('.menu')).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('restores focus before running the chosen item', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    let focusedDuringRun = null;
    openMenu(
      [
        {
          label: '&Go',
          run: () => {
            focusedDuringRun = document.activeElement;
          },
        },
      ],
      { x: 0, y: 0 },
    );
    key(document.activeElement, 'Enter');
    expect(focusedDuringRun).toBe(canvas);
    expect(document.activeElement).toBe(canvas);
  });

  it('keeps the menubar button focused when the menu was opened from it', () => {
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&File', items: [{ label: '&New', run: () => {} }] }]);
    const btn = bar.el.querySelector('button');
    btn.focus();
    key(btn, 'Enter');
    key(document.activeElement, 'Escape');
    expect(document.activeElement).toBe(btn);
  });
});

describe('properties panel fields', () => {
  const fakeApp = () => ({
    settings: { get: () => 'mm' },
    activeEditor: null,
    toast: () => {},
  });
  const mount = (spec) => {
    const panel = new PropertiesPanel(fakeApp());
    const changes = [];
    const [, input] = panel._field({ ...spec, onChange: (v) => changes.push(v) });
    const el = input.querySelector?.('input') || input;
    document.body.append(panel.el, input);
    return { el, changes };
  };

  it('Escape puts back a number without applying it', () => {
    const { el, changes } = mount({ label: 'Rotation', type: 'angle', value: 90 });
    el.focus();
    el.value = '45';
    el.dispatchEvent(new Event('input'));
    key(el, 'Escape');
    el.dispatchEvent(new Event('change'));
    expect(el.value).toBe('90');
    expect(changes).toEqual([]);
  });

  it('Enter applies a changed number once, and an unchanged one not at all', () => {
    const { el, changes } = mount({ label: 'Rotation', type: 'angle', value: 90 });
    el.focus();
    key(el, 'Enter');
    expect(changes).toEqual([]);
    el.value = '180';
    key(el, 'Enter');
    el.dispatchEvent(new Event('change'));
    expect(changes).toEqual([180]);
  });

  it('an invalid entry shows the real value again on blur', () => {
    const { el, changes } = mount({ label: 'X', type: 'length', value: 10_000_000 });
    el.focus();
    el.value = 'abc';
    el.dispatchEvent(new Event('change'));
    expect(el.getAttribute('aria-invalid')).toBe('true');
    el.blur();
    expect(el.value).toBe('10');
    expect(el.getAttribute('aria-invalid')).toBe('false');
    expect(changes).toEqual([]);
  });

  it('Escape in a live text field restores and applies the original text', () => {
    const { el, changes } = mount({ label: 'Designator', type: 'text', value: 'R1' });
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input'));
    key(el, 'Escape');
    expect(el.value).toBe('R1');
    expect(changes).toEqual(['', 'R1']);
  });
});
