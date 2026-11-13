import { it, expect, afterEach } from 'vitest';
import { openMenu, closeMenus } from '../src/ui/menu.js';
import { openDialog } from '../src/ui/dialog.js';

afterEach(() => {
  closeMenus();
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  document.body.replaceChildren();
});

it.each(['pointer', 'keyboard'])('returns focus to the root menu trigger after a nested dialog closes (%s)', async (input) => {
  document.body.innerHTML = '<button id="prior">Editor</button><button id="launch">Menu</button>';
  const launch = document.getElementById('launch');
  document.getElementById('prior').focus(); // Safari pointer clicks need not focus buttons.
  let done;
  const root = openMenu([{ type: 'submenu', label: 'Options', items: [{ label: 'Preferences', run: () => {
    done = openDialog({ title: 'Preferences', body: 'Settings' });
  } }] }], { anchor: launch });
  root.el.querySelector('button').click();
  const command = document.querySelectorAll('[role="menu"]')[1].querySelector('button');
  command.focus();
  if (input === 'pointer') command.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  else command.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(document.querySelector('.dialog').contains(document.activeElement)).toBe(true);
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await done;
  expect(document.activeElement).toBe(launch);
});

it('returns focus to the anchor on Escape even when a pointer opened the menu', () => {
  document.body.innerHTML = '<button id="launch">Menu</button>';
  const launch = document.getElementById('launch');
  openMenu([{ label: 'Item' }], { anchor: launch });
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.activeElement).toBe(launch);
});

it.each([false, true])('lets native Tab navigation continue from the menu trigger (reverse=%s)', (shiftKey) => {
  document.body.innerHTML = '<button id="launch">Menu</button><input aria-label="Next control">';
  const launch = document.getElementById('launch');
  openMenu([{ label: 'Item' }], { anchor: launch });
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(event);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  // jsdom does not perform native tab movement; the browser must receive an
  // uncanceled event with focus anchored at the surviving trigger.
  expect(event.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(launch);
});
