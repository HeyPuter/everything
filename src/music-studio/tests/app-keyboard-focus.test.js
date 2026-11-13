import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { openDialog } from '../src/ui/dialog.js';
import { closeMenus, openMenu } from '../src/ui/menu.js';

const listeners = [];
afterEach(() => {
  closeMenus();
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  for (const args of listeners.splice(0)) document.removeEventListener(...args);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const menubar = document.createElement('button');
  menubar.textContent = 'File';
  const control = document.createElement('button');
  control.textContent = 'Workspace control';
  document.body.append(menubar, control);
  const app = { toolbar: { menubar }, prefs: { get: () => false }, commands: { lookup: vi.fn() } };
  const add = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((...args) => { listeners.push(args); add(...args); });
  App.prototype.installKeyboard.call(app);
  spy.mockRestore();
  control.focus();
  return { control, menubar };
}

function press(options = {}) {
  const event = new KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true, ...options });
  document.activeElement.dispatchEvent(event);
  return event;
}

it('keeps F10 focus inside an open modal', async () => {
  const { menubar } = setup();
  const pending = openDialog({ title: 'Confirm', body: 'Keep focus here' });
  const focused = document.activeElement;
  expect(focused.closest('.dialog')).not.toBeNull();
  press();
  expect(document.activeElement).toBe(focused);
  document.querySelector('.dialog-head button').click();
  await pending;
  press();
  expect(document.activeElement).toBe(menubar);
});

it('keeps F10 focus inside an open popup menu', () => {
  setup();
  openMenu([{ label: 'Action' }]);
  const focused = document.activeElement;
  press();
  expect(document.activeElement).toBe(focused);
});

it('leaves composing F10 events to the input method', () => {
  const { control } = setup();
  const event = press({ isComposing: true });
  expect(document.activeElement).toBe(control);
  expect(event.defaultPrevented).toBe(false);
});

it('respects F10 already handled by a focused control', () => {
  const { control } = setup();
  control.addEventListener('keydown', (e) => e.preventDefault());
  press();
  expect(document.activeElement).toBe(control);
});

it('leaves F10 inside the account menu', () => {
  const { control } = setup();
  const account = document.createElement('puter-user-menu');
  document.body.append(account);
  account.append(control);
  control.focus();
  press();
  expect(document.activeElement).toBe(control);
});

it('focuses the menu bar with plain F10 and leaves typing and Shift+F10 alone', () => {
  const { control, menubar } = setup();
  expect(press().defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(menubar);
  control.focus();
  expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(control);
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  expect(press().defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
});
