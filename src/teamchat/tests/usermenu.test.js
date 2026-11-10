/**
 * puter.js's <puter-user-menu> at the end of the top bar (src/ui/usermenu.js):
 * where the SDK defines it, it holds the Puter account and the Apps launcher,
 * the app's own Sign out (the rail's menu, "You") stands down while it shows,
 * and its Sign out is the app's. Driven in node through tests/helpers/dom.js,
 * as the shell's own tests are; the element is a stand-in holding the Sign
 * out item the real one has (in its shadow root there, a child here: the
 * click is found on its way down to the item either way).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDom } from './helpers/dom.js';

vi.mock('../src/ui/conversation.js', () => ({
  createConversationView: (convId) => {
    const node = document.createElement('div');
    node.className = 'main';
    node.dataset.conv = convId;
    return { el: node, destroy() {}, renderHeader() {}, tab: () => 'messages', setTab() {}, jumpTo() {} };
  },
}));
vi.mock('../src/ui/huddle.js', () => ({
  mountHuddleDock() {},
  joinHuddleFlow() {},
  huddleButton() { return document.createElement('span'); },
  createHuddleBar() { return { el: document.createElement('div'), destroy() {} }; },
}));

const REF = 'abc123def0@teamchat-test';
const TAG = 'puter-user-menu';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;

/** The shell at a conversation, opened and settled, with or without the element in the SDK. */
async function shell({ element = true, env = 'web', width = 1280 } = {}) {
  dom?.uninstall();
  dom = installDom({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1`, width });
  vi.resetModules();
  globalThis.customElements = { get: (name) => (element && name === TAG ? class {} : undefined) };
  globalThis.puter = { env, workers: { exec: async () => json({ code: 'not_found', message: 'nope' }, 404) } };
  location.reload = vi.fn();
  const { store } = await import('../src/lib/store.js');
  const open = () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = {
      id: 'abc123def0', name: 'Globex',
      channels: { c1: { id: 'c1', name: 'general', def: true } },
      members: { 'u-me': { role: 'member', name: 'Me', username: 'me' } },
    };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    store.workspaces = [{ id: REF, name: 'Globex' }];
  };
  store.openWorkspace = async () => { open(); store.emit('workspace'); };
  store.startPolling = () => {};
  store.pokeSync = () => {};
  store.signOut = vi.fn(async () => {});
  const { mountShell } = await import('../src/ui/shell.js');
  const app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  mountShell(app);
  await dom.tick(5);
  const menu = app.querySelector(`.topbar ${TAG}`);
  // The Sign out item, with the element's own handler on it.
  const own = vi.fn();
  let escapes = 0;
  let item = null;
  if (menu) {
    item = document.createElement('button');
    item.className = 'menu-item sign-out';
    item.addEventListener('click', own);
    menu.append(item);
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') escapes++; });
  }
  return { store, app, dom, menu, item, own, escapes: () => escapes };
}

const menuLabels = () => [...document.querySelectorAll('.menu [role="menuitem"]')].map((n) => n.textContent);
const dialogButton = (text) => [...document.querySelectorAll('.modal-root button')].find((b) => b.textContent.trim() === text);

afterEach(() => {
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
  delete globalThis.customElements;
});

describe('without <puter-user-menu> in the SDK', () => {
  it('leaves the top bar as it was, and Sign out in the rail’s menu and in You', async () => {
    const { app, menu, dom: d } = await shell({ element: false });
    expect(menu).toBe(null);
    expect(app.querySelector('.topbar').lastElementChild.className).toBe('top-spacer');
    app.querySelector('.rail-me').click();
    await d.tick(5);
    expect(menuLabels().some((t) => t.includes('Sign out'))).toBe(true);
    const { settingsDialog } = await import('../src/ui/dialogs.js');
    settingsDialog();
    await d.tick(5);
    expect(dialogButton('Sign out')).toBeTruthy();
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  it('ends the top bar, and the app’s own Sign out stands down', async () => {
    const { app, menu, dom: d } = await shell();
    expect(menu).toBeTruthy();
    expect(app.querySelectorAll(TAG).length).toBe(1);
    const end = app.querySelector('.topbar').lastElementChild;
    expect(end.className).toBe('top-end');
    expect(end.lastElementChild).toBe(menu);
    // The rail's avatar keeps the workspace profile: status, notifications, settings.
    app.querySelector('.rail-me').click();
    await d.tick(5);
    expect(menuLabels().some((t) => t.includes('Profile and settings'))).toBe(true);
    expect(menuLabels().some((t) => t.includes('Sign out'))).toBe(false);
    const { settingsDialog } = await import('../src/ui/dialogs.js');
    settingsDialog();
    await d.tick(5);
    expect(dialogButton('Done')).toBeTruthy();
    expect(dialogButton('Sign out')).toBeFalsy();
  });

  it('stays with the bar through the shell’s redraws', async () => {
    const { store, app, menu, dom: d } = await shell();
    store.emit('workspace');
    store.emit('activity');
    store.emit('profile');
    await d.tick(20);
    expect(app.querySelector(`.topbar ${TAG}`)).toBe(menu);
    expect(app.querySelectorAll(TAG).length).toBe(1);
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    const { app, menu } = await shell({ env: 'app' });
    expect(menu).toBe(null);
    expect(app.querySelector('.topbar').lastElementChild.className).toBe('top-spacer');
  });

  it('keeps the app’s own Sign out on a phone, which has no top bar', async () => {
    const { app, dom: d } = await shell({ width: 400 });
    const { userMenuShown } = await import('../src/ui/usermenu.js');
    expect(userMenuShown()).toBe(false);
    app.querySelector('.rail-me').click();
    await d.tick(5);
    expect(menuLabels().some((t) => t.includes('Sign out'))).toBe(true);
  });

  it('hands Sign out to the app: asked first, then the store’s sign-out and a fresh page', async () => {
    const { store, item, own, escapes, dom: d } = await shell();
    item.click();
    await d.tick(5);
    expect(own).not.toHaveBeenCalled();
    expect(escapes()).toBe(1); // the element's menu is closed
    expect(document.querySelector('.modal-root .modal-title')?.textContent).toBe('Sign out?');
    expect(store.signOut).not.toHaveBeenCalled();
    dialogButton('Sign out').click();
    await d.tick(5);
    expect(store.signOut).toHaveBeenCalledTimes(1);
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('signs nobody out when the question is turned down', async () => {
    const { store, item, dom: d } = await shell();
    item.click();
    await d.tick(5);
    dialogButton('Cancel').click();
    await d.tick(5);
    expect(store.signOut).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('starts the page over after a sign-in or a sign-out the element did by itself', async () => {
    const { store, menu } = await shell();
    menu.dispatchEvent(new Event('signout'));
    expect(location.reload).toHaveBeenCalledTimes(1);
    menu.dispatchEvent(new Event('signin'));
    expect(location.reload).toHaveBeenCalledTimes(2);
    expect(store.signOut).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', async () => {
    const { menu } = await shell();
    const { applyTheme } = await import('../src/ui/theme.js');
    expect(menu.hasAttribute('theme')).toBe(false);
    applyTheme('dark');
    expect(menu.getAttribute('theme')).toBe('dark');
    applyTheme('system');
    expect(menu.hasAttribute('theme')).toBe(false);
  });

  it('counts as typing somewhere for the message shortcuts, whose keys reach the page from the element', async () => {
    await shell();
    const source = (await import('node:fs')).readFileSync(new URL('../src/ui/message.js', import.meta.url), 'utf8');
    expect(source).toContain("a.closest('.modal-root, .menu, puter-user-menu')");
  });
});
