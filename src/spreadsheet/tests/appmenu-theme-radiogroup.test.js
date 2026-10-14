// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { openAppMenu } from '../src/ui/appmenu.js';
import { session } from '../src/lib/session.js';
import { closeMenu } from '../src/ui/menu.js';

let anchor;
beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('puter', {
    env: 'web',
    auth: { isSignedIn: () => false, signIn: vi.fn(), getUser: async () => null, signOut: vi.fn() },
    kv: { get: async () => null, set: async () => true },
  });
  anchor = document.createElement('button');
  document.body.append(anchor);
  await session.init();
});
afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  session.state = 'unknown';
  session.user = null;
  vi.unstubAllGlobals();
});

const key = (target, k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
const radios = () => [...document.querySelectorAll('.segmented [role="radio"]')];
const checked = () => radios().map((r) => r.getAttribute('aria-checked'));

// The Help menu's "Keyboard shortcuts…" and "About Spreadsheet…" carry the ellipsis of an item that opens
// a dialog; the account menu's two copies of them did not.
describe('the account menu', () => {
  it('marks Keyboard shortcuts and About, which open dialogs, with an ellipsis', () => {
    openAppMenu(anchor);
    const labels = [...document.querySelectorAll('.menu-item')].map((b) => b.querySelector('.menu-label').childNodes[0].textContent);
    expect(labels).toContain('Keyboard shortcuts…');
    expect(labels).toContain('About…');
    expect(labels.filter((l) => /…$/.test(l))).toEqual(['Regional format…', 'Options…', 'Keyboard shortcuts…', 'About…']);
  });
});

// The three theme radios sat in a plain group, so a screen reader announced three loose radios; and
// Left and Right, the keys a radio group answers, did nothing there.
describe('the theme switch', () => {
  it('is a named radio group', () => {
    openAppMenu(anchor);
    const group = document.querySelector('.segmented');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Appearance');
    expect(radios()).toHaveLength(3);
    expect(radios().every((r) => r.closest('[role="radiogroup"]') === group)).toBe(true);
    expect(document.querySelectorAll('[aria-label="Appearance"]')).toHaveLength(1);
  });

  it('moves to the neighbouring theme on Right and Left, wrapping within the group, and chooses it', () => {
    openAppMenu(anchor);
    const [system, light, dark] = radios();
    system.focus();
    expect(checked()).toEqual(['true', 'false', 'false']);
    expect(key(system, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(light);
    expect(checked()).toEqual(['false', 'true', 'false']);
    expect(document.documentElement.dataset.theme).toBe('light');
    key(light, 'ArrowRight');
    expect(document.activeElement).toBe(dark);
    expect(checked()).toEqual(['false', 'false', 'true']);
    expect(document.documentElement.dataset.theme).toBe('dark');
    key(dark, 'ArrowRight');
    expect(document.activeElement).toBe(system);
    expect(checked()).toEqual(['true', 'false', 'false']);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    key(system, 'ArrowLeft');
    expect(document.activeElement).toBe(dark);
    expect(checked()).toEqual(['false', 'false', 'true']);
    expect(document.querySelector('.menu')).not.toBeNull(); // the menu stays open, as after a click on a segment
  });

  it('still leaves the group on Down and Up without choosing anything', () => {
    openAppMenu(anchor);
    const [system, , dark] = radios();
    dark.focus();
    key(dark, 'ArrowDown');
    expect(document.activeElement.querySelector('.menu-label').textContent).toBe('Regional format…');
    expect(checked()).toEqual(['true', 'false', 'false']);
    key(document.activeElement, 'ArrowUp');
    expect(document.activeElement).toBe(dark);
    key(dark, 'ArrowUp');
    expect(document.activeElement).not.toBe(system);
    expect(document.activeElement.getAttribute('role')).toBe('radio');
    expect(checked()).toEqual(['true', 'false', 'false']);
  });
});
