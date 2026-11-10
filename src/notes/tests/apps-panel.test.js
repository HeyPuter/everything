import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus, isMenuOpen } from '../src/ui/menu.js';
import { setTheme } from '../src/ui/prefs.js';
import { appsButton, isAppsPanelOpen, APPS_EMBED_URL, APPS_NEWTAB_URL } from '../src/ui/apps-panel.js';

// The Apps launcher in the title bar: a 3×3 button opening a panel that embeds puter.com/embed/apps.

let app;
const panel = () => document.querySelector('.apps-panel');
const shown = () => !!panel() && !panel().hidden;
const press = (target) => target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

async function mount(env = 'web') {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env, onSignOut: () => {} });
  await app.start();
  return app;
}

beforeEach(() => {
  // jsdom lays nothing out; the panel closes when its button has no box.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 900, right: 928, top: 6, bottom: 34, width: 28, height: 28 });
});
afterEach(() => {
  closeAllMenus();
  app?.destroy();
  app = null;
  document.body.replaceChildren();
  setTheme('system');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the Apps button', () => {
  it('sits in the title bar just left of Share, named and announcing a closed dialog', async () => {
    await mount();
    const btn = app.titlebar.querySelector('.apps-btn');
    expect(btn).toBe(app.appsBtn);
    expect(btn.nextElementSibling).toBe(app.shareBtn);
    expect(btn.getAttribute('aria-label')).toBe('Apps');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelectorAll('circle')).toHaveLength(9);
  });

  it('is left out inside a Puter app window', async () => {
    expect(appsButton({ env: 'app' })).toBe(null);
    await mount('app');
    expect(app.titlebar.querySelector('.apps-btn')).toBe(null);
  });

  it('toggles a labelled panel on <body> embedding Puter apps', async () => {
    await mount();
    const btn = app.appsBtn;
    btn.click();
    expect(shown()).toBe(true);
    expect(isAppsPanelOpen()).toBe(true);
    expect(panel().parentElement).toBe(document.body);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel().getAttribute('role')).toBe('dialog');
    expect(panel().getAttribute('aria-label')).toBe('Apps');
    expect(panel().getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel());
    const frame = panel().querySelector('iframe.apps-frame');
    expect(frame.src).toBe(APPS_EMBED_URL);
    expect(frame.title).toBe('Your Puter apps');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame.getAttribute('allow')).toBe('clipboard-read; clipboard-write');
    const link = panel().querySelector('.apps-panel-newtab');
    expect(link.getAttribute('href')).toBe(APPS_NEWTAB_URL);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(panel().style.getPropertyValue('--apps-panel-top')).toBe('44px');

    btn.click();
    expect(shown()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a spinner until the embed loads, and is built once', async () => {
    await mount();
    const btn = app.appsBtn;
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
  it('Escape and ✕ close it and hand focus back to the button', async () => {
    await mount();
    const btn = app.appsBtn;
    btn.click();
    key(panel(), 'Escape');
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);

    btn.click();
    panel().querySelector('.apps-panel-close').click();
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('a press outside closes it; a press inside or on the button does not', async () => {
    await mount();
    const btn = app.appsBtn;
    btn.click();
    press(panel().querySelector('.apps-panel-header'));
    expect(shown()).toBe(true);
    press(btn);
    expect(shown()).toBe(true);
    press(app.canvasCol);
    expect(shown()).toBe(false);
  });

  it('opening the account menu closes it, and opening it closes the menu', async () => {
    await mount();
    app.appsBtn.click();
    app.avatar.click();
    expect(shown()).toBe(false);
    expect(isMenuOpen()).toBe(true);

    app.appsBtn.click();
    expect(isMenuOpen()).toBe(false);
    expect(shown()).toBe(true);

    app.mobileMore.click();
    expect(shown()).toBe(false);
    expect(isMenuOpen()).toBe(true);
  });

  it('closes on resize once its button has no box', async () => {
    await mount();
    app.appsBtn.click();
    Element.prototype.getClientRects.mockReturnValue([]);
    window.dispatchEvent(new Event('resize'));
    expect(shown()).toBe(false);
    expect(app.appsBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('is removed when the app is torn down', async () => {
    await mount();
    app.appsBtn.click();
    app.destroy();
    app = null;
    expect(panel()).toBe(null);
  });
});

describe('theme', () => {
  it('pins the embed to the app’s light or dark theme', async () => {
    await mount();
    setTheme('dark');
    app.appsBtn.click();
    const frame = panel().querySelector('iframe');
    expect(frame.style.colorScheme).toBe('dark');
    setTheme('light');
    expect(frame.style.colorScheme).toBe('light');
    setTheme('system'); // jsdom's matchMedia reports light
    expect(frame.style.colorScheme).toBe('light');
  });
});
