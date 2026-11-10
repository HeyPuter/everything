/**
 * Twenty-second review pass, the shell: the shell's router, the lists and
 * the stylesheet, driven in node through tests/helpers/dom.js (a small DOM:
 * elements, selectors, bubbling events with capture, focus, matchMedia by
 * viewport and pointer; no CSS). Every test boots a fresh DOM and a fresh
 * module registry, as tests/ui-shell-pass21.test.js does.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDom } from './helpers/dom.js';

// The conversation column, the huddle dock and the thread panel stand in as
// small boxes: the shell modules under test import them, and none of these
// tests is about them (as tests/ui-shell-pass19.test.js has it).
vi.mock('../src/ui/conversation.js', () => ({
  createConversationView: (convId) => {
    const node = document.createElement('div');
    node.className = 'main';
    node.dataset.conv = convId;
    node.append(document.createElement('textarea'));
    return { el: node, destroy() {}, renderHeader() {}, tab: () => 'messages', setTab() {}, jumpTo() {} };
  },
}));
vi.mock('../src/ui/huddle.js', () => ({
  mountHuddleDock() {},
  joinHuddleFlow: vi.fn(),
  huddleButton() { return document.createElement('span'); },
  createHuddleBar() { return { el: document.createElement('div'), destroy() {} }; },
}));
vi.mock('../src/ui/panel.js', () => ({
  renderThreadPanel: (panelEl, { onClose }) => {
    const close = document.createElement('button');
    close.className = 'icon-btn panel-close';
    close.addEventListener('click', onClose);
    panelEl.append(close);
    return { destroy() {}, jumpTo() {} };
  },
}));
// The chimes played, recorded rather than done.
const chimes = [];
vi.mock('../src/lib/notify.js', async (importOriginal) => ({
  ...(await importOriginal()),
  playNotificationSound: (opts) => { chimes.push(opts || {}); },
}));

const REF = 'abc123def0@teamchat-test';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;

afterEach(() => {
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
});

/** A fresh DOM and fresh modules with a faked Puter and a small workspace the store opens when asked (see tests/ui-shell-pass19.test.js). */
async function bootApp({ hash = '', width = 1280, routes = {}, ...env } = {}) {
  dom?.uninstall();
  dom = installDom({ hash, width, ...env });
  vi.resetModules();
  const calls = [];
  globalThis.puter = {
    workers: {
      exec: async (url, init = {}) => {
        const u = new URL(url);
        calls.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
        const hit = Object.entries(routes).find(([k]) => u.pathname.endsWith(k));
        if (!hit) return json({ code: 'not_found', message: 'nope' }, 404);
        return hit[1](u.searchParams, init);
      },
    },
  };
  const { store } = await import('../src/lib/store.js');
  const open = () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = {
      id: 'abc123def0', name: 'Globex',
      channels: {
        c1: { id: 'c1', name: 'general', def: true },
        c2: { id: 'c2', name: 'ops' },
        c3: { id: 'c3', name: 'random', count: 2 },
      },
      members: {
        'u-me': { role: 'member', name: 'Me', username: 'me' },
        'u-dan': { role: 'member', name: 'Dan Ito', username: 'dan' },
      },
    };
    store.me = {
      role: 'member', channels: ['c1', 'c2'],
      dms: { dm_d: { members: ['u-me', 'u-dan'], createdAt: 3 } },
      reads: {}, mentions: {}, notify: {}, threads: {},
    };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    store.workspaces = [{ id: REF, name: 'Globex' }];
  };
  store.openWorkspace = async () => { open(); store.emit('workspace'); };
  store.startPolling = () => {};
  store.pokeSync = () => {};
  return { store, open, calls, dom };
}

/** The shell mounted on a fresh app root, routed to the DOM's hash. */
async function mountedShell(ctx) {
  const { mountShell } = await import('../src/ui/shell.js');
  const app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  mountShell(app);
  await ctx.dom.tick(10);
  return app;
}

const emptyPage = () => json({ results: [], cursor: null, hasMore: false, indexed: true, failed: 0 });

describe('a view in the main column (Files, the Directory, Threads) left for a search and come back to', () => {
  it('is drawn again in the column, where the dead results page stood on', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/files`, routes: { '/search': emptyPage, '/messages': () => json({ messages: [], seq: 0 }) } });
    const { buildHash } = await import('../src/lib/router.js');
    const app = await mountedShell(ctx);
    const inColumn = () => app.querySelector('#main');
    expect(inColumn()?.querySelector('h1')?.textContent).toBe('Files');
    // A search typed into the top bar: the results take the column.
    location.hash = buildHash({ ws: REF, query: 'build' });
    await ctx.dom.tick(10);
    expect(inColumn()?.classList.contains('search-view')).toBe(true);
    // Back: the Files view again.
    location.hash = buildHash({ ws: REF, view: 'files' });
    await ctx.dom.tick(10);
    expect(inColumn()?.classList.contains('search-view')).toBe(false);
    expect(inColumn()?.querySelector('h1')?.textContent).toBe('Files');
    expect(inColumn()?.isConnected).toBe(true);
  });

  it('the Directory the same way, and its list is live (drawn for the workspace as it stands)', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/directory`, routes: { '/search': emptyPage, '/messages': () => json({ messages: [], seq: 0 }) } });
    const { buildHash } = await import('../src/lib/router.js');
    const app = await mountedShell(ctx);
    const inColumn = () => app.querySelector('#main');
    expect(inColumn()?.classList.contains('dir-view')).toBe(true);
    location.hash = buildHash({ ws: REF, query: 'build' });
    await ctx.dom.tick(10);
    expect(inColumn()?.classList.contains('search-view')).toBe(true);
    location.hash = buildHash({ ws: REF, view: 'directory' });
    await ctx.dom.tick(10);
    expect(inColumn()?.classList.contains('dir-view')).toBe(true);
    expect(inColumn()?.querySelectorAll('.dir-card').length).toBe(2);
  });
});

describe('Copy link and Copy name in a sidebar row\'s menu, in a browser without the clipboard API', () => {
  it('copy the older way and say so, or say they could not, rather than doing nothing, as every other copy does', async () => {
    const ctx = await bootApp();
    ctx.open();
    const { rowMenuItems } = await import('../src/ui/notifymenu.js');
    navigator.clipboard = undefined;
    const copied = [];
    document.execCommand = vi.fn(() => { copied.push(document.activeElement?.value); return true; });
    const toasts = () => [...document.querySelectorAll('.toast-root .toast')].map((n) => n.textContent);
    const pick = (label) => rowMenuItems('c1', {}).find((it) => it && it.label === label);
    // A row focused, as the keyboard has it when the menu opens from Shift+F10.
    const row = document.createElement('a');
    row.href = '#/x';
    document.body.append(row);
    row.focus();
    pick('Copy link').onSelect();
    await ctx.dom.tick(2);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(copied[0]).toMatch(/#\/ws\/.*\/c\/c1$/);
    expect(toasts()).toContain('Link copied');
    // The keyboard is back where it was.
    expect(document.activeElement).toBe(row);
    pick('Copy name').onSelect();
    await ctx.dom.tick(2);
    expect(copied[1]).toBe('#general');
    expect(toasts()).toContain('Name copied');
    // And when even the older way is refused, the reader hears so.
    document.execCommand = vi.fn(() => false);
    pick('Copy link').onSelect();
    await ctx.dom.tick(2);
    expect(toasts()).toContain('Could not copy');
  });
});

describe('a sidebar row\'s menu standing open while a poll draws the sidebar again', () => {
  it('keeps the kebab it hangs from drawn under the menu, and lets it go when the menu closes', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    ctx.open();
    const { renderSidebar } = await import('../src/ui/sidebar.js');
    const { closeMenu } = await import('../src/ui/menu.js');
    const nav = document.createElement('nav');
    document.body.append(nav);
    renderSidebar(nav);
    await ctx.dom.tick(5);
    const kebabOf = (title) => [...nav.querySelectorAll('.side-kebab')].find((k) => k.getAttribute('aria-label') === `Options for ${title}`) || null;
    const kebab = kebabOf('#ops');
    expect(kebab).not.toBeNull();
    kebab.click();
    await ctx.dom.tick(2);
    expect(document.querySelector('.menu[role="menu"]')).not.toBeNull();
    // The kebab is held drawn by aria-expanded (see .side-kebab[aria-expanded="true"]).
    expect(kebab.getAttribute('aria-expanded')).toBe('true');
    // Someone else's message arrives: the sidebar is drawn afresh under the open menu.
    ctx.store.emit('activity');
    await ctx.dom.tick(5);
    const again = kebabOf('#ops');
    expect(again).not.toBeNull();
    expect(again).not.toBe(kebab);
    expect(document.querySelector('.menu[role="menu"]')).not.toBeNull();
    expect(again.getAttribute('aria-expanded')).toBe('true');
    // No other row's kebab is drawn for it.
    expect(kebabOf('#general').getAttribute('aria-expanded') ?? 'false').toBe('false');
    // The menu closes: the kebab now showing the row lets go too, rather than standing drawn for good.
    closeMenu();
    await ctx.dom.tick(2);
    expect(document.querySelector('.menu[role="menu"]')).toBeNull();
    expect(again.getAttribute('aria-expanded')).toBe('false');
    // And a redraw after the close carries nothing.
    ctx.store.emit('activity');
    await ctx.dom.tick(5);
    expect(kebabOf('#ops').getAttribute('aria-expanded') ?? 'false').toBe('false');
  });
});

describe('the "Move to…" list opened from a sidebar row\'s menu, the sidebar drawn again meanwhile', () => {
  it('keeps the row\'s kebab drawn under the list as under the menu, keyed by the conversation rather than the button it opened on', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    ctx.open();
    const { renderSidebar } = await import('../src/ui/sidebar.js');
    const { closeMenu } = await import('../src/ui/menu.js');
    const nav = document.createElement('nav');
    document.body.append(nav);
    renderSidebar(nav);
    await ctx.dom.tick(5);
    const kebabOf = (title) => [...nav.querySelectorAll('.side-kebab')].find((k) => k.getAttribute('aria-label') === `Options for ${title}`) || null;
    const menu = () => document.querySelector('.menu[role="menu"]');
    kebabOf('#ops').click();
    await ctx.dom.tick(2);
    // A poll draws the sidebar again under the open menu: the mark is carried (see the test above).
    ctx.store.emit('activity');
    await ctx.dom.tick(5);
    const k2 = kebabOf('#ops');
    expect(k2.getAttribute('aria-expanded')).toBe('true');
    // "Move to…" opens its list in the menu's place, from the button the menu opened on, gone from the page by now.
    [...menu().querySelectorAll('.menu-item')].find((b) => /^Move to/.test(b.textContent)).click();
    await ctx.dom.tick(2);
    expect(menu()?.getAttribute('aria-label')).toBe('Move to');
    expect(k2.getAttribute('aria-expanded')).toBe('true');
    // And another poll while the list stands.
    ctx.store.emit('activity');
    await ctx.dom.tick(5);
    const k3 = kebabOf('#ops');
    expect(k3).not.toBe(k2);
    expect(k3.getAttribute('aria-expanded')).toBe('true');
    expect(kebabOf('#general').getAttribute('aria-expanded') ?? 'false').toBe('false');
    // The list closes: the kebab lets go.
    closeMenu();
    await ctx.dom.tick(2);
    expect(menu()).toBeNull();
    expect(k3.getAttribute('aria-expanded')).toBe('false');
    ctx.store.emit('activity');
    await ctx.dom.tick(5);
    expect(kebabOf('#ops').getAttribute('aria-expanded') ?? 'false').toBe('false');
  });
});

describe('a long section name in the sidebar (forty letters, twenty emoji, right-to-left words)', () => {
  const css = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('is cut short with an ellipsis in its heading, the heading\'s own buttons kept in reach, rather than running past the sidebar', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    ctx.open();
    const name = '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
    ctx.store.sections = () => [{ id: 's1', name, items: ['c2'] }];
    ctx.store.sectionOf = (id) => (id === 'c2' ? { id: 's1', name, items: ['c2'] } : null);
    const { renderSidebar } = await import('../src/ui/sidebar.js');
    const nav = document.createElement('nav');
    document.body.append(nav);
    renderSidebar(nav);
    await ctx.dom.tick(5);
    const heading = [...nav.querySelectorAll('.side-head > button.side-title')].find((b) => b.textContent.includes('🚀'));
    expect(heading).not.toBeNull();
    // The words in a box of their own, which the stylesheet may cut; the chevron beside it stays whole.
    const words = heading.querySelector('.side-title-text');
    expect(words).not.toBeNull();
    expect(words.textContent).toBe(name);
    expect(words.getAttribute('dir')).toBe('auto');
    expect(heading.getAttribute('aria-controls')).toBe('side-sec-s1');
    // The Options button beside the heading is there to press.
    expect(heading.parentElement.querySelector(`[aria-label="Options for ${name}"]`)).not.toBeNull();
    // In the stylesheet: the heading may shrink below its words, and the words are cut with an ellipsis.
    const app = css('app.css');
    expect(app).toMatch(/\.side-head > button\.side-title \{[^}]*min-width: 0;/);
    expect(app).toMatch(/\.side-title-text \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    // And the name at the head of the section's own menu wraps rather than running out of the menu.
    expect(css('components.css')).toMatch(/\.menu-label \{[^}]*overflow-wrap: anywhere;/);
  });
});

describe('a reminder deleted meanwhile (another tab, another device), then Done or Snooze pressed on its row here', () => {
  it('reads the list again so the row goes, and says the worker\'s words, as Send now already does for a scheduled message', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/later` });
    ctx.open();
    const { store } = ctx;
    const { ApiError } = await import('../src/lib/api.js');
    const message = { seq: 1, user: 'u-dan', ts: 1000, text: 'water the plants', kind: 'msg', attachments: [], mentions: [], reactions: {} };
    const reminder = (id) => ({ id, kind: 'reminder', conv: 'c1', seq: 1, dueAt: Date.now() + 3_600_000, note: '', message });
    let held = [reminder('r1'), reminder('r2')];
    let reads = 0;
    store.loadSaved = async () => [];
    store.loadScheduled = async () => { reads++; return { reminders: held, scheduled: [] }; };
    const gone = async () => { throw new ApiError(404, 'not_found', 'Nothing scheduled with that id'); };
    store.deleteScheduled = gone;
    store.updateScheduled = gone;
    const toasts = () => [...document.querySelectorAll('.toast-root .toast')].map((n) => n.textContent);
    const { createListView } = await import('../src/ui/views.js');
    const view = createListView('later', { pane: true });
    document.body.append(view.el);
    await ctx.dom.tick(5);
    [...view.el.querySelectorAll('[role="radio"]')][1].click(); // Reminders
    await ctx.dom.tick(5);
    expect(view.el.querySelectorAll('.later-row').length).toBe(2);
    const before = reads;
    // Done on the first reminder, gone from the worker meanwhile.
    held = [reminder('r2')];
    view.el.querySelector('.later-row [aria-label="Done, remove reminder"]').click();
    await ctx.dom.tick(10);
    expect(toasts().some((t) => /Nothing scheduled with that id/.test(t))).toBe(true);
    expect(reads).toBe(before + 1);
    expect(view.el.querySelectorAll('.later-row').length).toBe(1);
    expect(view.el.querySelector('.later-row').dataset.entry).toBe('r2');
    // Snooze on the one left, gone as well.
    held = [];
    view.el.querySelector('.later-row [aria-label="Snooze"]').click();
    await ctx.dom.tick(2);
    const preset = [...document.querySelectorAll('.menu[role="menu"] .menu-item')].find((b) => !/Custom time/.test(b.textContent));
    expect(preset).toBeTruthy();
    preset.click();
    await ctx.dom.tick(10);
    expect(reads).toBe(before + 2);
    expect(view.el.querySelectorAll('.later-row').length).toBe(0);
    expect(view.el.querySelector('.empty h3')?.textContent).toBe('No reminders');
    view.destroy();
  });
});

describe('the keyboard on a section\'s Options button when the section is renamed or deleted', () => {
  it('stays on that section\'s Options button under its new name, then goes to the heading that took the deleted section\'s place', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    ctx.open();
    let sections = [{ id: 's1', name: 'Projects', items: ['c2'] }];
    ctx.store.sections = () => sections;
    ctx.store.sectionOf = (id) => sections.find((s) => s.items.includes(id)) || null;
    const { renderSidebar } = await import('../src/ui/sidebar.js');
    const nav = document.createElement('nav');
    document.body.append(nav);
    renderSidebar(nav);
    await ctx.dom.tick(5);
    const opts = nav.querySelector('[aria-label="Options for Projects"]');
    expect(opts).not.toBeNull();
    // The Options menu's Rename went through its dialog, which gave the keyboard back to the button; the rename lands.
    opts.focus();
    sections = [{ id: 's1', name: 'Work', items: ['c2'] }];
    ctx.store.emit('profile');
    await ctx.dom.tick(5);
    expect(opts.isConnected).toBe(false);
    expect(document.activeElement.getAttribute('aria-label')).toBe('Options for Work');
    // Delete, the same way: the section goes, and the keyboard with it went to the page.
    const before = [...nav.querySelectorAll('.side-section')];
    const index = before.indexOf(document.activeElement.closest('.side-section'));
    expect(index).toBeGreaterThanOrEqual(0);
    sections = [];
    ctx.store.emit('profile');
    await ctx.dom.tick(5);
    expect(nav.querySelector('[aria-label="Options for Work"]')).toBeNull();
    const after = [...nav.querySelectorAll('.side-section')];
    const landed = after[Math.min(index, after.length - 1)].querySelector('.side-title');
    expect(document.activeElement).toBe(landed);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('a saved item removed from Later meanwhile (another tab, another device), then its done mark pressed here', () => {
  it('reads the list again so the row goes, and says the worker\'s words, as Remove already ends up doing', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/later` });
    ctx.open();
    const { store } = ctx;
    const { ApiError } = await import('../src/lib/api.js');
    const message = { seq: 1, user: 'u-dan', ts: 1000, text: 'water the plants', kind: 'msg', attachments: [], mentions: [], reactions: {} };
    let held = [{ c: 'c1', s: 1, ts: 900, done: false, message }, { c: 'c1', s: 2, ts: 800, done: false, message: { ...message, seq: 2 } }];
    let reads = 0;
    store.loadSaved = async () => { reads++; return held; };
    store.loadScheduled = async () => ({ reminders: [], scheduled: [] });
    store.saveDone = async () => { throw new ApiError(404, 'not_found', 'Not saved'); };
    const toasts = () => [...document.querySelectorAll('.toast-root .toast')].map((n) => n.textContent);
    const { createListView } = await import('../src/ui/views.js');
    const view = createListView('later', { pane: true });
    document.body.append(view.el);
    await ctx.dom.tick(5);
    expect(view.el.querySelectorAll('.later-row').length).toBe(2);
    const before = reads;
    held = [held[1]];
    view.el.querySelector('.later-row [aria-label="Mark done"]').click();
    await ctx.dom.tick(10);
    expect(toasts().some((t) => /Not saved/.test(t))).toBe(true);
    expect(reads).toBe(before + 1);
    expect(view.el.querySelectorAll('.later-row').length).toBe(1);
    view.destroy();
  });
});

describe('the Direct messages list\'s last line for a group conversation whose newest line the system wrote', () => {
  it('shows the line as it is, with nobody named as having said it', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/dms`, routes: { '/messages': () => json({ messages: [], seq: 0 }) } });
    ctx.open();
    const { store } = ctx;
    store.ws.members['u-eve'] = { role: 'member', name: 'Eve Adams', username: 'eve' };
    store.me.dms.dm_g = { members: ['u-me', 'u-dan', 'u-eve'], createdAt: 4 };
    const line = (seq, user, text, kind) => ({ seq, user, ts: 1000 + seq, text, kind, attachments: [], mentions: [], reactions: {} });
    // The huddle's end, written by the system with its starter as the subject.
    Object.assign(store.conv('dm_g'), { loaded: true, seq: 3, hasMore: false, messages: [line(3, 'u-dan', 'Huddle ended after 5 min', 'sys')] });
    // And a line of the same kind whose subject is the reader, and one with no subject at all.
    Object.assign(store.conv('dm_d'), { loaded: true, seq: 2, hasMore: false, messages: [line(2, 'u-me', 'Huddle ended after 2 min', 'sys')] });
    const { createDmsPane } = await import('../src/ui/dmspane.js');
    const pane = createDmsPane();
    document.body.append(pane.el);
    await ctx.dom.tick(10);
    const text = (id) => [...pane.el.querySelectorAll('.pane-row')].find((r) => r.getAttribute('href').includes(id)).querySelector('.pane-row-text').textContent;
    expect(text('dm_g')).toBe('Huddle ended after 5 min');
    expect(text('dm_d')).toBe('Huddle ended after 2 min');
    Object.assign(store.conv('dm_g'), { messages: [line(4, 'sys', 'This conversation was shared', 'sys')], seq: 4 });
    store.emit('messages', { conv: 'dm_g', reason: 'newer' });
    await ctx.dom.tick(5);
    expect(text('dm_g')).toBe('This conversation was shared');
    pane.destroy();
  });
});

describe('a long name in a menu (a workspace of sixty letters in the switcher, a channel in a row\'s menu), in the stylesheet', () => {
  const css = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('wraps inside the item rather than running out of the menu, while the card at the top keeps its one line with an ellipsis', () => {
    const c = css('components.css');
    // The item's words sit in a bare span beside the icon (see menu.js openMenu): it may break anywhere.
    expect(c).toMatch(/\.menu-item > span \{[^}]*overflow-wrap: anywhere;/);
    // The menu itself is bounded; the words must not widen it.
    expect(c).toMatch(/\.menu \{[^}]*max-width: min\(320px, calc\(100vw - 16px\)\);/);
    // The card's title and its second line are one line each, cut with an ellipsis, as before.
    expect(c).toMatch(/\.menu-card-text strong \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    expect(c).toMatch(/\.menu-card-text span \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  });
});

describe('the Directory\'s cards across the workspace changing in ways that do not touch them', () => {
  it('keeps the cards already drawn (a channel\'s topic, a star), and draws them afresh only when what a card shows has changed', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/directory` });
    ctx.open();
    const { store } = ctx;
    const { createDirectoryView } = await import('../src/ui/directory.js');
    const view = createDirectoryView();
    document.body.append(view.el);
    await ctx.dom.tick(5);
    const cards = () => [...view.el.querySelectorAll('.dir-card')];
    const first = cards();
    expect(first.length).toBe(2);
    // The workspace's document moved for a reason no card shows (a channel's topic).
    store.ws.channels.c1.topic = 'Plans for the week';
    store.emit('workspace');
    await ctx.dom.tick(5);
    expect(cards()).toEqual(first);
    // The reader starred a channel: their own document moved.
    store.emit('profile');
    await ctx.dom.tick(5);
    expect(cards()).toEqual(first);
    // The words in the box still narrow the cards that are there.
    ctx.dom.type(view.el.querySelector('.dir-search'), 'dan');
    expect(cards().length).toBe(1);
    expect(cards()[0]).toBe(first.find((c) => /Dan Ito/.test(c.textContent)));
    ctx.dom.type(view.el.querySelector('.dir-search'), '');
    // Someone's title changed: the cards are drawn afresh, and say so.
    store.ws.members['u-dan'].title = 'Head of Ops';
    store.emit('workspace');
    await ctx.dom.tick(5);
    expect(cards()).not.toEqual(first);
    expect(view.el.textContent).toContain('Head of Ops');
    // Someone's dot changed: drawn afresh, as before.
    const second = cards();
    store.presenceOf = (u) => (u === 'u-dan' ? 'active' : 'offline');
    store.emit('activity');
    await ctx.dom.tick(5);
    expect(cards()).not.toEqual(second);
    view.destroy();
  });
});

describe('the "started a huddle" toast\'s Join, pressed after the reader has switched to another workspace', () => {
  it('goes back to the call, in its own workspace and conversation, rather than acting on the conversation of the same id here', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1`, routes: { '/messages': () => json({ messages: [], seq: 0 }) } });
    const app = await mountedShell(ctx);
    const { store } = ctx;
    const { joinHuddleFlow } = await import('../src/ui/huddle.js');
    store.profile.prefs.sound = false;
    store.emit('huddle-started', [{ conv: 'dm_d', by: 'u-dan' }]);
    await ctx.dom.tick(2);
    const join = [...document.querySelectorAll('.toast-root .toast')].find((t) => /started a huddle/.test(t.textContent))?.querySelector('.toast-action');
    expect(join).toBeTruthy();
    expect(join.textContent).toBe('Join');
    // Meanwhile the reader opened another workspace (a direct message between the same two people carries the same id there).
    const OTHER = 'ffff000000@teamchat-test';
    store.wsId = OTHER;
    store.workspaces = [{ id: REF, name: 'Globex' }, { id: OTHER, name: 'Initech' }];
    join.click();
    await ctx.dom.tick(10);
    expect(joinHuddleFlow).not.toHaveBeenCalled();
    expect(location.hash).toBe(`#/ws/${encodeURIComponent(REF)}/c/dm_d`);
    expect(app).toBeTruthy();
  });

  it('joins at once while the reader is still in the call\'s workspace', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1`, routes: { '/messages': () => json({ messages: [], seq: 0 }) } });
    await mountedShell(ctx);
    const { store } = ctx;
    const { joinHuddleFlow } = await import('../src/ui/huddle.js');
    store.profile.prefs.sound = false;
    store.emit('huddle-started', [{ conv: 'dm_d', by: 'u-dan' }]);
    await ctx.dom.tick(2);
    [...document.querySelectorAll('.toast-root .toast')].find((t) => /started a huddle/.test(t.textContent)).querySelector('.toast-action').click();
    await ctx.dom.tick(2);
    expect(joinHuddleFlow).toHaveBeenCalledWith('dm_d');
  });
});

describe('the keyboard on a row of the sidebar\'s list when something takes the list\'s place', () => {
  it('goes to the pane that took it (Shift+Cmd+D from a channel row on a desk), rather than staying on the hidden row', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1`, routes: { '/messages': () => json({ messages: [], seq: 0 }) } });
    const { buildHash } = await import('../src/lib/router.js');
    const app = await mountedShell(ctx);
    const row = app.querySelector(`.sidebar-home a.side-item[href="${buildHash({ ws: REF, conv: 'c2' })}"]`);
    expect(row).not.toBeNull();
    row.focus();
    expect(document.activeElement).toBe(row);
    location.hash = buildHash({ ws: REF, view: 'dms' });
    await ctx.dom.tick(10);
    const pane = app.querySelector('.sidebar-pane');
    expect(pane.hidden).toBe(false);
    expect(app.querySelector('.sidebar-home').hidden).toBe(true);
    expect(pane.contains(document.activeElement)).toBe(true);
    expect(document.activeElement.className).toContain('side-filter-input');
  });

  it('goes into the view that took the screen on a phone (Threads from its row), where the list is hidden under it', async () => {
    const ctx = await bootApp({ hash: `#/ws/${encodeURIComponent(REF)}`, width: 400, routes: { '/messages': () => json({ messages: [], seq: 0 }), '/threads': () => json({ threads: [] }) } });
    const { buildHash } = await import('../src/lib/router.js');
    const app = await mountedShell(ctx);
    const row = app.querySelector(`.sidebar-home a.side-item[href="${buildHash({ ws: REF, view: 'threads' })}"]`);
    expect(row).not.toBeNull();
    row.focus();
    location.hash = buildHash({ ws: REF, view: 'threads' });
    await ctx.dom.tick(10);
    const main = app.querySelector('#main');
    expect(main.querySelector('h1')?.textContent).toBe('Threads');
    expect(app.querySelector('.shell').classList.contains('show-sidebar')).toBe(false);
    expect(main.contains(document.activeElement)).toBe(true);
    // Not a text box under a finger.
    expect(/^(input|textarea)$/.test(document.activeElement.localName)).toBe(false);
  });
});

describe('the keyboard shortcuts panel\'s search box, its empty result said aloud', () => {
  it('says "No shortcut matches …" once the list empties, nothing while rows match, and the same words only once', async () => {
    const ctx = await bootApp();
    ctx.open();
    const { renderShortcutsPanel } = await import('../src/ui/shortcuts.js');
    const panel = document.createElement('aside');
    document.body.append(panel);
    renderShortcutsPanel(panel, { onClose() {} });
    await ctx.dom.tick(2);
    const status = panel.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    const box = panel.querySelector('.shortcuts-search');
    ctx.dom.type(box, 'thread');
    expect(panel.querySelectorAll('.shortcut-row').length).toBeGreaterThan(0);
    expect(status.textContent).toBe('');
    ctx.dom.type(box, 'threadzz');
    expect(panel.querySelectorAll('.shortcut-row').length).toBe(0);
    expect(panel.querySelector('.side-empty').textContent).toBe('No shortcut matches “threadzz”');
    expect(status.textContent).toBe('No shortcut matches “threadzz”');
    // The same region stands from the start; the words change with the box, and clear when rows match again.
    expect(panel.querySelector('[role="status"]')).toBe(status);
    ctx.dom.type(box, 'threadzzz');
    expect(status.textContent).toBe('No shortcut matches “threadzzz”');
    ctx.dom.type(box, '');
    expect(status.textContent).toBe('');
  });
});
