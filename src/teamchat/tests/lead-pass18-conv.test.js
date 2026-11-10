/**
 * Dialogs checked by the lead in review pass 18, driven in node through
 * tests/helpers/dom.js as the pass-17 lead tests are.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDom } from './helpers/dom.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/theme.js', () => ({ applyTheme: vi.fn(), currentTheme: () => 'system', isDark: () => false }));
vi.mock('../src/ui/modal.js', () => ({
  confirmDialog: vi.fn(async () => true),
  closeAllModals: vi.fn(),
  openModal: vi.fn(({ content, onClose }) => {
    document.body.append(content);
    const close = vi.fn(() => { content.remove(); onClose?.(); });
    return { close, panel: content, root: content };
  }),
}));
vi.mock('../src/lib/router.js', async (importOriginal) => ({ ...(await importOriginal()), navigate: vi.fn() }));
vi.mock('../src/lib/archive.js', async (importOriginal) => ({ ...(await importOriginal()), transferWorkspace: vi.fn() }));
vi.mock('../src/lib/pwa.js', async (importOriginal) => ({ ...(await importOriginal()), isIos: () => false, isStandalone: () => false, canInstall: () => false }));

const REF = 'abc123def0@teamchat-test';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;
let store = null;

async function boot(prefs = {}) {
  dom?.uninstall();
  dom = installDom({ width: 1280 });
  vi.resetModules();
  // A website with Puter's notifications: the push row is drawn.
  globalThis.puter = { env: 'web', notifications: {}, workers: { exec: async () => json({ code: 'not_found', message: 'nope' }, 404) } };
  ({ store } = await import('../src/lib/store.js'));
  store.wsId = REF;
  store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs };
  store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'general', def: true, count: 1 } }, members: { 'u-me': { role: 'member', name: 'Me', username: 'me', color: 1 } } };
  store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
  store.act = { c: {}, p: {}, w: 0, u: 0 };
  store.workspaces = [{ id: REF, name: 'Globex' }];
  store.statusOf = () => null;
  store.notificationsPaused = () => false;
  return dom;
}

afterEach(async () => {
  await dom?.tick(5);
  store?.stopPolling();
  store = null;
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
  delete globalThis.Notification;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the "Notifications when the app is closed" switch', () => {
  const switchFor = (label) => [...document.querySelectorAll('[role="switch"]')].find((s) => s.textContent.includes(label));

  async function open(prefs, permission, status = permission === 'granted' ? 'on' : 'blocked') {
    vi.stubEnv('PROD', true);
    globalThis.Notification = { permission, requestPermission: async () => permission };
    const d = await boot(prefs);
    puter.notifications.status = vi.fn(async () => status);
    const { settingsDialog } = await import('../src/ui/dialogs.js');
    settingsDialog();
    await d.tick(2);
    const row = switchFor('Notifications when the app is closed');
    expect(row).toBeTruthy();
    return row;
  }

  it('reads on while the preference stands and the browser still allows notifications', async () => {
    const row = await open({ push: true, notify: true }, 'granted');
    expect(row.getAttribute('aria-checked')).toBe('true');
  });

  it('reads off once the browser has stopped allowing them, though the preference stands, and is the only notification switch', async () => {
    const row = await open({ push: true }, 'denied');
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Desktop notifications')).toBeFalsy();
  });

  it('reads off when Puter disabled the app, even with browser permission', async () => {
    const row = await open({ push: true }, 'granted', 'off');
    expect(row.getAttribute('aria-checked')).toBe('false');
  });

  it('reads off when the preference is off, whatever the browser allows', async () => {
    const row = await open({ push: false }, 'granted');
    expect(row.getAttribute('aria-checked')).toBe('false');
  });
});
