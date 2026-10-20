import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { attachMenu } from '../src/ui/menu.js';
import { el } from '../src/ui/dom.js';

/** The dropdown behind the settings and account buttons. */

let anchor;
let button;

const open = () => button.click();
const items = () => [...document.querySelectorAll('.menu [role^="menuitem"]')];
const roles = () => items().map((node) => node.getAttribute('role'));

beforeEach(() => {
  button = el('button', { type: 'button' }, 'Settings');
  anchor = el('div.menu-anchor', {}, button);
  document.body.append(anchor);
});

afterEach(() => {
  anchor.remove();
});

describe('attachMenu', () => {
  it('opens and closes on the trigger, and says so', () => {
    attachMenu(button, () => [{ label: 'One', onSelect: () => {} }]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(items()).toHaveLength(1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(document.querySelector('.menu')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('builds the items fresh on every open', () => {
    let label = 'First';
    attachMenu(button, () => [{ label, onSelect: () => {} }]);
    open();
    expect(items()[0].textContent).toBe('First');
    button.click();
    label = 'Second';
    open();
    expect(items()[0].textContent).toBe('Second');
  });

  it('tells a choice between several apart from a setting that is on or off', () => {
    attachMenu(button, () => [
      { header: 'Theme' },
      { label: 'Light', checked: true, onSelect: () => {} },
      { label: 'Dark', checked: false, onSelect: () => {} },
      { separator: true },
      { label: 'Notify me', checked: false, toggle: true, onSelect: () => {} },
      { label: 'Sign out', onSelect: () => {} },
    ]);
    open();
    expect(roles()).toEqual([
      'menuitemradio', 'menuitemradio', 'menuitemcheckbox', 'menuitem',
    ]);
    expect(items().map((node) => node.getAttribute('aria-checked')))
      .toEqual(['true', 'false', 'false', null]);
    expect(document.querySelectorAll('.menu-header')).toHaveLength(1);
    expect(document.querySelectorAll('.menu-sep')).toHaveLength(1);
  });

  it('is named after its button, and groups the items under each caption', () => {
    attachMenu(button, () => [
      { header: 'Theme' },
      { label: 'Light', checked: true, onSelect: () => {} },
      { label: 'Dark', checked: false, onSelect: () => {} },
      { header: 'Density' },
      { label: 'Comfortable', checked: true, onSelect: () => {} },
      { separator: true },
      { label: 'Sign out', onSelect: () => {} },
    ]);
    open();
    const menu = document.querySelector('.menu');
    expect(menu.getAttribute('aria-label')).toBe('Settings');
    const groups = [...menu.querySelectorAll('[role="group"]')];
    const name = (group) => document.getElementById(group.getAttribute('aria-labelledby')).textContent;
    expect(groups.map(name)).toEqual(['Theme', 'Density']);
    // One checked choice per group, not three in one set.
    expect(groups.map((group) => group.querySelectorAll('[aria-checked="true"]').length)).toEqual([1, 1]);
    // What follows a separator belongs to no caption.
    expect(items().at(-1).closest('[role="group"]')).toBeNull();
    // The arrow keys still reach every item.
    expect(items()).toHaveLength(4);
  });

  it('runs the item, closes, and gives focus back to the trigger', () => {
    let ran = 0;
    attachMenu(button, () => [{ label: 'One', onSelect: () => { ran++; } }]);
    open();
    items()[0].click();
    expect(ran).toBe(1);
    expect(document.querySelector('.menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('wraps the arrow keys around the items', () => {
    attachMenu(button, () => [
      { label: 'One', onSelect: () => {} },
      { label: 'Two', onSelect: () => {} },
    ]);
    open();
    expect(document.activeElement).toBe(items()[0]);
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    press('ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items()[1]);
    press('Home');
    expect(document.activeElement).toBe(items()[0]);
    press('End');
    expect(document.activeElement).toBe(items()[1]);
  });

  it('closes on Escape without letting it reach anything behind', () => {
    attachMenu(button, () => [{ label: 'One', onSelect: () => {} }]);
    open();
    let behind = 0;
    const listener = () => { behind++; };
    document.addEventListener('keydown', listener);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', listener);
    expect(document.querySelector('.menu')).toBeNull();
    expect(behind).toBe(0);
  });
});

describe('leaving the menu with the keyboard', () => {
  const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('closes on Tab and hands focus back to the trigger, so Tab carries on from there', () => {
    attachMenu(button, () => [
      { label: 'One', onSelect: () => {} },
      { label: 'Two', onSelect: () => {} },
    ]);
    open();
    expect(document.activeElement).toBe(items()[0]);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(document.querySelector('.menu')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    // The browser's own Tab is left to move focus on from the trigger.
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes when focus lands somewhere else on the page', () => {
    const elsewhere = el('button', { type: 'button' }, 'Elsewhere');
    document.body.append(elsewhere);
    attachMenu(button, () => [{ label: 'One', onSelect: () => {} }]);
    open();
    const item = items()[0];
    item.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: elsewhere }));
    expect(document.querySelector('.menu')).toBeNull();
    elsewhere.remove();
  });

  it('stays open while focus moves between its own items, or reports no destination', () => {
    attachMenu(button, () => [
      { label: 'One', onSelect: () => {} },
      { label: 'Two', onSelect: () => {} },
    ]);
    open();
    const [one, two] = items();
    one.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: two }));
    expect(document.querySelector('.menu')).not.toBeNull();
    // A click on an item in a browser that does not focus buttons.
    one.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(document.querySelector('.menu')).not.toBeNull();
    press('Escape');
  });
});
