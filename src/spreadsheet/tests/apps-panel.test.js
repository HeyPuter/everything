// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { appsButton, closeAppsPanel, isAppsPanelOpen, APPS_EMBED_URL, APPS_NEWTAB_URL } from '../src/ui/apps-panel.js';
import { openAppMenu } from '../src/ui/appmenu.js';
import { session } from '../src/lib/session.js';
import { closeMenu } from '../src/ui/menu.js';

// The Apps launcher beside the account button: a 3×3 button opening a panel that embeds puter.com/embed/apps.

let sdk;
const panel = () => document.querySelector('.apps-panel');
const shown = () => !!panel() && !panel().hidden;
const press = (target) => target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function mount() {
  const btn = appsButton();
  document.body.append(btn);
  return btn;
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // jsdom lays nothing out; the panel closes when its button has no box, as a hidden button has none.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 336, top: 6, bottom: 42, width: 36, height: 36 });
  sdk = {
    env: 'web',
    _user: null,
    auth: { isSignedIn: () => !!sdk._user, signIn: vi.fn(), getUser: async () => sdk._user, signOut: vi.fn() },
    kv: { get: async () => null, set: async () => true },
  };
  vi.stubGlobal('puter', sdk);
  await session.init();
});
afterEach(() => {
  closeAppsPanel();
  closeMenu();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  session.state = 'unknown';
  session.user = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the Apps button', () => {
  it('is offered on the web, named, announcing a dialog that starts closed', () => {
    const btn = mount();
    expect(btn.getAttribute('aria-label')).toBe('Apps');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelectorAll('circle')).toHaveLength(9);
  });

  it('is left out inside a Puter app window, whose desktop has its own launcher', () => {
    sdk.env = 'app';
    expect(appsButton()).toBe(null);
  });

  it('toggles a labelled panel embedding the person\'s Puter apps', () => {
    const btn = mount();
    btn.click();
    expect(shown()).toBe(true);
    expect(isAppsPanelOpen()).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel().getAttribute('role')).toBe('dialog');
    expect(panel().getAttribute('aria-label')).toBe('Apps');
    expect(document.activeElement).toBe(panel());
    const frame = panel().querySelector('iframe.apps-frame');
    expect(frame.src).toBe(APPS_EMBED_URL);
    expect(frame.title).toBe('Your Puter apps');
    expect(panel().querySelector('.apps-panel-newtab').getAttribute('href')).toBe(APPS_NEWTAB_URL);
    expect(panel().querySelector('.apps-panel-newtab').target).toBe('_blank');
    // The caret points at the button's centre.
    expect(panel().style.getPropertyValue('--apps-panel-top')).toBe('52px');

    btn.click();
    expect(shown()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a spinner until the embed loads, and is built once', () => {
    const btn = mount();
    btn.click();
    const body = panel().querySelector('.apps-panel-body');
    expect(body.classList.contains('is-loading')).toBe(true);
    panel().querySelector('iframe').dispatchEvent(new Event('load'));
    expect(body.classList.contains('is-loading')).toBe(false);
    const first = panel();
    btn.click();
    btn.click();
    expect(panel()).toBe(first);
    expect(document.querySelectorAll('.apps-panel')).toHaveLength(1);
  });
});

describe('closing the panel', () => {
  it('Escape and ✕ close it and hand focus back to the button', () => {
    const btn = mount();
    btn.click();
    key(panel(), 'Escape');
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);

    btn.click();
    panel().querySelector('.apps-panel-close').click();
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('a press outside closes it; a press inside or on the button does not', () => {
    const btn = mount();
    const elsewhere = document.createElement('div');
    document.body.append(elsewhere);
    btn.click();
    press(panel().querySelector('.apps-panel-header'));
    expect(shown()).toBe(true);
    press(btn);
    expect(shown()).toBe(true);
    press(elsewhere);
    expect(shown()).toBe(false);
  });

  it('opening the account menu closes it', () => {
    const btn = mount();
    const avatar = document.createElement('button');
    document.body.append(avatar);
    btn.click();
    openAppMenu(avatar);
    expect(shown()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when its button leaves with its view', () => {
    const btn = mount();
    btn.click();
    btn.remove();
    window.dispatchEvent(new Event('resize'));
    expect(shown()).toBe(false);
  });
});

describe('the embed', () => {
  it('follows the app theme, not only the OS', () => {
    document.documentElement.dataset.theme = 'dark';
    const btn = mount();
    btn.click();
    expect(panel().querySelector('iframe').style.colorScheme).toBe('dark');
  });

  it('is loaded afresh after signing in, for the new account', async () => {
    const btn = mount();
    btn.click();
    const first = panel();
    sdk._user = { username: 'nariman', uuid: 'u1' };
    await session.init();
    expect(first.isConnected).toBe(false);
    btn.click();
    expect(panel()).not.toBe(first);
    expect(shown()).toBe(true);
  });
});
