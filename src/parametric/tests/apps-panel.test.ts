// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPS_EMBED_URL, APPS_NEWTAB_URL, appsButton, closeAppsPanel, isAppsPanelOpen, syncAppsLauncher } from '../src/app/apps-panel';
import { bindAccountMenu, refreshAccount } from '../src/app/start';
import type { App } from '../src/app/app';
import { closeMenus, isMenuOpen, openMenu } from '../src/ui/menu';
import { setPuterForTests, type PuterSDK } from '../src/platform/puter';

// The Apps launcher beside the account button: a 3×3 button opening a panel that embeds puter.com/embed/apps.

let signedIn = false;
const panel = () => document.querySelector<HTMLElement>('.apps-panel');
const shown = () => !!panel() && !panel()!.hidden;
const press = (t: Element) => t.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
const key = (t: Element, k: string) => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function sdk(env = 'web'): PuterSDK {
  return {
    env,
    auth: { isSignedIn: () => signedIn, signIn: vi.fn(), signOut: vi.fn(), getUser: async () => ({ username: 'nariman' }) },
  } as unknown as PuterSDK;
}

function mount() {
  const btn = appsButton();
  document.body.append(btn);
  return btn;
}

beforeEach(() => {
  signedIn = false;
  setPuterForTests(sdk());
  // jsdom lays nothing out; the panel closes when its button has no box, as a hidden button has none.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 330, top: 5, bottom: 35, width: 30, height: 30 } as DOMRect);
});
afterEach(() => {
  closeAppsPanel();
  closeMenus();
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeResolved;
  setPuterForTests(null);
  vi.restoreAllMocks();
});

describe('the Apps button', () => {
  it('is named and announces a dialog that starts closed', () => {
    const btn = mount();
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Apps');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelectorAll('circle')).toHaveLength(9);
  });

  it('is hidden inside a Puter app window, whose desktop has its own launcher', () => {
    const btn = mount();
    setPuterForTests(sdk('app'));
    syncAppsLauncher(btn);
    expect(btn.hidden).toBe(true);
    expect(appsButton().hidden).toBe(true);
  });

  it('toggles a labelled panel embedding the person\'s Puter apps', () => {
    const btn = mount();
    btn.click();
    expect(shown()).toBe(true);
    expect(isAppsPanelOpen()).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const p = panel()!;
    expect(p.parentElement).toBe(document.body);
    expect(p.getAttribute('role')).toBe('dialog');
    expect(p.getAttribute('aria-label')).toBe('Apps');
    expect(document.activeElement).toBe(p);
    const frame = p.querySelector('iframe')!;
    expect(frame.src).toBe(APPS_EMBED_URL);
    expect(frame.title).toBe('Your Puter apps');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame.getAttribute('allow')).toBe('clipboard-read; clipboard-write');
    const link = p.querySelector<HTMLAnchorElement>('.apps-panel-newtab')!;
    expect(link.getAttribute('href')).toBe(APPS_NEWTAB_URL);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(p.style.getPropertyValue('--apps-panel-top')).toBe('45px');

    btn.click();
    expect(shown()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a spinner until the embed loads, and is built once', () => {
    const btn = mount();
    btn.click();
    const body = panel()!.querySelector('.apps-panel-body')!;
    expect(body.classList.contains('is-loading')).toBe(true);
    panel()!.querySelector('iframe')!.dispatchEvent(new Event('load'));
    expect(body.classList.contains('is-loading')).toBe(false);
    const first = panel();
    btn.click();
    btn.click();
    expect(panel()).toBe(first);
    expect(document.querySelectorAll('.apps-panel')).toHaveLength(1);
  });
});

describe('closing the panel', () => {
  it('Escape and ✕ close it and hand focus back to the button; Escape goes no further', () => {
    const btn = mount();
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    btn.click();
    key(panel()!, 'Escape');
    window.removeEventListener('keydown', onWindow);
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);
    expect(onWindow).not.toHaveBeenCalled();

    btn.click();
    panel()!.querySelector<HTMLButtonElement>('.apps-panel-close')!.click();
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('a press outside closes it without taking the press; one inside or on the button does not', () => {
    const btn = mount();
    const elsewhere = document.createElement('canvas');
    document.body.append(elsewhere);
    btn.click();
    press(panel()!.querySelector('.apps-panel-header')!);
    expect(shown()).toBe(true);
    press(btn.querySelector('svg')!);
    expect(shown()).toBe(true);
    const seen = vi.fn((e: Event) => e.defaultPrevented);
    elsewhere.addEventListener('pointerdown', seen);
    press(elsewhere);
    expect(shown()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.results[0].value).toBe(false);
  });

  it('opening it closes an open menu; opening the account menu closes it', () => {
    const btn = mount();
    const account = document.createElement('button');
    document.body.append(account);
    openMenu([{ label: 'Item' }], 0, 0);
    expect(isMenuOpen()).toBe(true);
    btn.click();
    expect(isMenuOpen()).toBe(false);
    expect(shown()).toBe(true);

    bindAccountMenu({ shell: { account, apps: btn } } as unknown as App);
    account.click();
    expect(shown()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when its button leaves', () => {
    const btn = mount();
    btn.click();
    btn.remove();
    window.dispatchEvent(new Event('resize'));
    expect(shown()).toBe(false);
  });
});

describe('the embed', () => {
  it('follows the app theme, not only the OS', () => {
    document.documentElement.dataset.themeResolved = 'dark';
    const btn = mount();
    btn.click();
    const frame = panel()!.querySelector('iframe')!;
    expect(frame.style.colorScheme).toBe('dark');
    document.documentElement.dataset.themeResolved = 'light';
    window.dispatchEvent(new CustomEvent('themechange'));
    expect(frame.style.colorScheme).toBe('light');
  });

  it('is loaded afresh after signing in, for the new account', async () => {
    const btn = mount();
    const account = document.createElement('button');
    btn.click();
    const first = panel()!;
    signedIn = true;
    await refreshAccount({ shell: { account, apps: btn } } as unknown as App);
    expect(first.isConnected).toBe(false);
    btn.click();
    expect(panel()).not.toBe(first);
    expect(shown()).toBe(true);
  });
});
