/**
 * Fourteenth review pass, the shell: the offline strip, the list views and
 * the app frame, driven in node through tests/helpers/dom.js (a small DOM:
 * elements, selectors, bubbling events, focus, a hash location that fires
 * hashchange on the next tick, matchMedia by viewport; no CSS, so an element
 * counts as rendered when it is connected and not under a [hidden]
 * ancestor). Every test boots a fresh DOM and a fresh module registry, so
 * the listeners the modules hang on window and document never outlive their
 * test. Puter is faked at `puter.workers.exec`, as in tests/store.test.js.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { installDom } from './helpers/dom.js';

// The conversation column and the huddle window are stubbed where the whole
// shell is mounted (their own tests cover them), as in the pass-13 file.
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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;

/** A fresh DOM and fresh modules; the store opens a small workspace when asked. */
async function boot({ hash = '', width = 1280, routes = {}, ...env } = {}) {
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

afterEach(() => {
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
});

/** The shell at a route, opened and settled. */
async function shell(opts = {}) {
  const ctx = await boot({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1`, ...opts });
  const { mountShell } = await import('../src/ui/shell.js');
  const app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  mountShell(app);
  await ctx.dom.tick(5);
  return { ...ctx, app };
}

describe('a focused row that leaves the list on a redraw', () => {
  it('in the DMs pane: hands the keyboard to the row that took its place, then the filter box, never the page', async () => {
    const ctx = await boot({ hash: `#/ws/${encodeURIComponent(REF)}/dms`, routes: { '/messages': () => json({ messages: [], seq: 0 }) } });
    const { store, dom: d } = ctx;
    ctx.open();
    store.ws.members['u-hanna'] = { role: 'member', name: 'Hanna Müller', username: 'hmueller' };
    store.me.dms.dm_h = { members: ['u-me', 'u-hanna'], createdAt: 5 };
    const { createDmsPane } = await import('../src/ui/dmspane.js');
    const pane = createDmsPane();
    document.body.append(pane.el);
    await d.tick(10);
    const rows = () => [...pane.el.querySelectorAll('.pane-row')];
    const names = () => rows().map((r) => r.querySelector('strong').textContent);
    expect(names()).toEqual(['Hanna Müller', 'Dan Ito']); // newest first
    rows()[1].focus();
    expect(document.activeElement).toBe(rows()[1]);
    // The conversation with Dan is gone from the list (its record removed): the keyboard lands on the row now at its place, the last one.
    delete store.me.dms.dm_d;
    store.emit('workspace');
    await d.tick(10);
    expect(names()).toEqual(['Hanna Müller']);
    expect(document.activeElement).toBe(rows()[0]);
    // Unreads only, with the one row unread: read on another device, it leaves the list, and the keyboard goes to the filter box.
    store.act.c = { dm_h: { s: 3, t: 1 } };
    pane.el.querySelector('.switch').click();
    await d.tick(10);
    expect(names()).toEqual(['Hanna Müller']);
    rows()[0].focus();
    store.me.reads.dm_h = 3;
    store.emit('activity');
    await d.tick(10);
    expect(rows().length).toBe(0);
    expect(pane.el.querySelector('.side-empty').textContent).toBe('Nothing unread.');
    expect(document.activeElement).toBe(pane.el.querySelector('.side-filter-input'));
    pane.destroy();
  });

  it('in the sidebar: a channel left while its row had the keyboard hands it to the row that took its place', async () => {
    const { store, app, dom: d } = await shell();
    // The rows: the five views, #general, #ops, then the one direct message.
    const hrefs = () => [...app.querySelectorAll('.side-item')].map((n) => n.getAttribute('href')).filter(Boolean).map((h) => h.split(/\/ws\/[^/]+\//)[1]);
    expect(hrefs()).toEqual(['threads', 'activity', 'later', 'drafts', 'directory', 'c/c1', 'c/c2', 'c/dm_d']);
    const row = app.querySelector(`.side-item[href$="/c/c2"]`);
    row.focus();
    expect(document.activeElement).toBe(row);
    // #ops is left (from another device, say): the row goes with the poll's redraw, and the keyboard lands on the row now at its place.
    store.me.channels = ['c1'];
    store.emit('workspace');
    await d.tick(10);
    expect(hrefs()).toEqual(['threads', 'activity', 'later', 'drafts', 'directory', 'c/c1', 'c/dm_d']);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.getAttribute('href')).toMatch(/\/c\/dm_d$/);
    // The last row of all goes: the keyboard goes to the row before it.
    delete store.me.dms.dm_d;
    store.emit('workspace');
    await d.tick(10);
    expect(hrefs()).toEqual(['threads', 'activity', 'later', 'drafts', 'directory', 'c/c1']);
    expect(document.activeElement.getAttribute('href')).toMatch(/\/c\/c1$/);
  });
});

describe('the recent searches under the top bar\'s box', () => {
  it('keep the keyboard, and the list open, when one is forgotten or all are cleared from the keyboard', async () => {
    const { app, dom: d } = await shell();
    const { noteSearch, recentSearches } = await import('../src/lib/recent.js');
    for (const q of ['alpha', 'beta', 'gamma']) noteSearch(REF, q);
    const input = app.querySelector('.top-search-input');
    const drop = app.querySelector('.top-search-drop');
    input.focus();
    expect(drop.hidden).toBe(false);
    const labels = () => [...drop.querySelectorAll('.top-drop-recent .top-drop-text')].map((n) => n.textContent);
    expect(labels()).toEqual(['gamma', 'beta', 'alpha']); // newest first
    // Forget the middle one from its own button: the keyboard lands on the row that took its place.
    const xs = () => [...drop.querySelectorAll('.top-drop-x')];
    xs()[1].focus();
    expect(document.activeElement.getAttribute('aria-label')).toBe('Forget “beta”');
    xs()[1].click();
    expect(labels()).toEqual(['gamma', 'alpha']);
    expect(recentSearches(REF)).toEqual(['gamma', 'alpha']);
    expect(document.activeElement).toBe(xs()[1]);
    expect(document.activeElement.getAttribute('aria-label')).toBe('Forget “alpha”');
    await d.tick(150);
    expect(drop.hidden).toBe(false); // the list stays: the keyboard is still in it
    // The last row forgotten: the keyboard goes to the row before it.
    xs()[1].click();
    expect(labels()).toEqual(['gamma']);
    expect(document.activeElement).toBe(xs()[0]);
    // The only row forgotten: what is left of the list is the "Search in #general" row (a conversation is open), and the keyboard goes there.
    xs()[0].click();
    expect(labels()).toEqual([]);
    expect(document.activeElement.classList.contains('top-drop-scope')).toBe(true);
    await d.tick(150);
    expect(drop.hidden).toBe(false);
    // Clear, from the keyboard: the box again.
    for (const q of ['delta', 'epsilon']) noteSearch(REF, q);
    input.blur();
    input.focus();
    const clear = drop.querySelector('.top-drop-clear');
    clear.focus();
    clear.click();
    expect(recentSearches(REF)).toEqual([]);
    expect(document.activeElement).toBe(input);
    await d.tick(150);
    expect(drop.hidden).toBe(false);
  });
});

describe('losing access to a workspace while switching to another', () => {
  const OTHER = 'bbbb222200@teamchat-test';

  it('forgets the lost one and leaves the reader where they went, rather than sending them home and on to that workspace\'s first channel', async () => {
    const ctx = await boot({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    const { store, dom: d } = ctx;
    // Two workspaces; opening the second sets the store to it.
    const openOther = () => {
      store.wsId = OTHER;
      store.ws = { id: 'bbbb222200', name: 'Initech', channels: { x1: { id: 'x1', name: 'ops' }, x2: { id: 'x2', name: 'general', def: true } }, members: { 'u-me': { role: 'member', name: 'Me', username: 'me' } } };
      store.me = { role: 'member', channels: ['x1', 'x2'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
      store.act = { c: {}, p: {}, w: 0, u: 0 };
    };
    store.openWorkspace = async (ref) => { if (ref === OTHER) openOther(); else ctx.open(); store.workspaces = [{ id: REF, name: 'Globex' }, { id: OTHER, name: 'Initech' }]; store.emit('workspace'); };
    const forgotten = [];
    let release = null;
    store.forgetWorkspace = (ref) => { forgotten.push(ref); return new Promise((r) => { release = r; }); };
    const { mountShell } = await import('../src/ui/shell.js');
    const { ApiError } = await import('../src/lib/api.js');
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    mountShell(app);
    await d.tick(5);
    // The worker says the reader is no longer a member: the workspace is being forgotten (a write to the account).
    store.emit('error', new ApiError(403, 'forbidden', 'You are not a member of this workspace'));
    await d.tick(5);
    expect(forgotten).toEqual([REF]);
    expect([...document.querySelectorAll('.toast span')].map((n) => n.textContent)).toContain('You no longer have access to this workspace');
    // Meanwhile the reader opens a conversation in their other workspace.
    location.hash = `#/ws/${encodeURIComponent(OTHER)}/c/x1`;
    await d.tick(10);
    expect(store.wsId).toBe(OTHER);
    expect(app.querySelector('.main')?.dataset.conv).toBe('x1');
    // The write lands: they stay where they are.
    release();
    await d.tick(20);
    expect(location.hash).toBe(`#/ws/${encodeURIComponent(OTHER)}/c/x1`);
    expect(app.querySelector('.main')?.dataset.conv).toBe('x1');
    expect(forgotten).toEqual([REF]); // and nothing else was forgotten
  });

  it('still sends the reader home when they have not gone anywhere', async () => {
    const ctx = await boot({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    const { store, dom: d } = ctx;
    let release = null;
    store.forgetWorkspace = () => new Promise((r) => { release = r; });
    const { mountShell } = await import('../src/ui/shell.js');
    const { ApiError } = await import('../src/lib/api.js');
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    mountShell(app);
    await d.tick(5);
    store.emit('error', new ApiError(404, 'not_found', 'No such workspace'));
    await d.tick(5);
    store.workspaces = []; // out of the list now
    release();
    await d.tick(20);
    expect(location.hash).toBe('#/'); // home: nothing left to open
    expect(app.querySelector('.auth-title')?.textContent).toBe('No workspace yet');
  });
});

describe('the handle that resizes the sidebar', () => {
  it('lets a modified arrow pass (the browser\'s Back and Forward) and still takes the bare ones', async () => {
    const { app, dom: d } = await shell();
    const handle = app.querySelector('.side-resizer');
    expect(handle.getAttribute('role')).toBe('separator');
    handle.focus();
    expect(document.activeElement).toBe(handle);
    const width = () => document.documentElement.style.getPropertyValue('--sidebar-w');
    expect(width()).toBe(''); // the stylesheet's default
    for (const mod of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      expect(d.key(handle, 'ArrowRight', mod).defaultPrevented).toBe(false);
      expect(d.key(handle, 'ArrowLeft', mod).defaultPrevented).toBe(false);
      expect(d.key(handle, 'Home', mod).defaultPrevented).toBe(false);
      expect(width()).toBe('');
    }
    expect(d.key(handle, 'ArrowRight').defaultPrevented).toBe(true);
    expect(width()).toMatch(/^clamp\(220px, \d+px, /); // the bare arrow resizes
    expect(d.key(handle, 'End').defaultPrevented).toBe(true);
    expect(width()).toContain(', 480px, ');
  });
});

describe('the Activity pane behind an open conversation', () => {
  const mention = (seq) => ({ k: 'mention', c: 'c1', s: seq, by: 'u-dan', ts: 1000 + seq, message: { seq, user: 'u-dan', ts: 1000 + seq, text: `hi @me ${seq}`, kind: 'msg' } });

  it('leaves the badge for a mention that lands while the layout hides the pane, and reads it once the route shows the pane again', async () => {
    const reads = [];
    let items = [mention(3)];
    // On a phone, a row picked in the Activity pane opens its conversation over the pane: the route keeps `activity` and the sidebar is hidden.
    const ctx = await boot({
      hash: `#/ws/${encodeURIComponent(REF)}/activity`,
      width: 390,
      routes: {
        '/inbox/read': () => { reads.push(1); return json({ ok: true }); },
        '/inbox': () => json({ items }),
      },
    });
    const { store, dom: d } = ctx;
    ctx.open();
    store._schedule = () => {}; // the store's own visibilitychange handler would start a poll
    store.me.inbox = 1;
    const { createListView } = await import('../src/ui/views.js');
    const view = createListView('activity', { pane: true });
    // The sidebar the pane lives in; the phone layout hides it (display: none) while a conversation is open, which no box models here: [hidden] stands for it.
    const sidebar = document.createElement('nav');
    sidebar.append(view.el);
    document.body.append(sidebar);
    await d.tick(5);
    // The pane is the screen: read, here and on every other device.
    expect(reads.length).toBe(1);
    expect(store.me.inbox).toBe(0);
    store.emit('workspace'); // the poll's first word since the view opened: the baseline
    await d.tick(5);
    // A row is picked: the conversation takes the screen and the pane stays mounted behind it, out of sight.
    location.hash = `#/ws/${encodeURIComponent(REF)}/activity/c/c1/m/3`;
    sidebar.hidden = true;
    await d.tick(10);
    expect(reads.length).toBe(1);
    // A mention lands meanwhile.
    items = [mention(4), mention(3)];
    store.me.inbox = 1;
    store.emit('workspace');
    await d.tick(5);
    expect(view.el.querySelectorAll('.view-row').length).toBe(2); // the list is drawn afresh all the same
    expect(reads.length).toBe(1); // but not read: the reader sees the conversation, not the pane, and the phone keeps its badge
    expect(store.me.inbox).toBe(1);
    expect(store.inboxUnread()).toBe(1);
    // The tab going to the background and coming back changes nothing while the pane is out of sight.
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await d.tick(5);
    expect(reads.length).toBe(1);
    // Back to the pane: the route shows it again, and now it is seen and read.
    sidebar.hidden = false;
    location.hash = `#/ws/${encodeURIComponent(REF)}/activity`;
    await d.tick(10);
    expect(reads.length).toBe(2);
    expect(store.me.inbox).toBe(0);
    // Nothing more to read: the next route asks the worker nothing.
    location.hash = `#/ws/${encodeURIComponent(REF)}/activity/c/c2`;
    await d.tick(10);
    expect(reads.length).toBe(2);
    view.destroy();
    // Gone from the page: a route or a tab shown again reads nothing on its behalf.
    store.me.inbox = 1;
    location.hash = `#/ws/${encodeURIComponent(REF)}/activity`;
    document.dispatchEvent(new Event('visibilitychange'));
    await d.tick(10);
    expect(reads.length).toBe(2);
  });
});

describe('the top safe area, in the stylesheet', () => {
  // The rules of app.css as (selector, declarations) pairs, media queries
  // flattened: the fake DOM applies no CSS, so the contract is read from the
  // text. The bars that take the notch's inset (padding with --safe-t) must
  // each be told not to when something above them has taken it already.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2].trim().replace(/\s+/g, ' ') }));
  const zeroing = (prefix) => rules.find((r) => r.sel.startsWith(prefix) && r.body.includes('--safe-t: 0px'));

  it('gives the 26px controls of the shell a 30px hit area under a finger, without resizing them to the eye', () => {
    // The last coarse-pointer block of app.css, where the file's own touch sizes live.
    const at = css.lastIndexOf('@media (pointer: coarse)');
    expect(at).toBeGreaterThan(0);
    let depth = 0;
    let end = css.indexOf('{', at);
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    const coarse = css.slice(at, end).replace(/\s+/g, ' ');
    expect(coarse).toContain('.switch.switch-sm, .top-drop-x { position: relative; }');
    expect(coarse).toMatch(/\.switch\.switch-sm::before \{ content: ''; position: absolute; inset: -2px 0; \}/);
    expect(coarse).toMatch(/\.top-drop-x::before \{ content: ''; position: absolute; inset: -2px; \}/);
    // The controls themselves keep their look: 26px, padding 4px on the switch.
    expect(rules.find((r) => r.sel === '.top-drop-x')?.body).toMatch(/width: 26px; height: 26px/);
    expect(rules.find((r) => r.sel === '.switch.switch-sm')?.body).toMatch(/padding: 4px 6px/);
    expect(rules.find((r) => r.sel === '.switch.switch-sm .switch-track')?.body).toMatch(/height: 18px/);
    // And nothing else in either stylesheet already draws a ::before on them.
    const both = css + readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
    expect(both.match(/\.switch\.switch-sm::before/g).length).toBe(1);
    expect(both.match(/\.top-drop-x::before/g).length).toBe(1);
  });

  it('the strip for a workspace being moved takes the inset when it is the first row on the screen, and the bars under it, and the strip under the top bar, then add none', () => {
    // Every plain bar that adds the inset to its own padding.
    const strips = ['.topbar', '.offline-banner', '.transfer-strip'];
    const bars = rules.filter((r) => /^\.[\w-]+$/.test(r.sel) && /padding[^;]*var\(--safe-t\)/.test(r.body) && !strips.includes(r.sel)).map((r) => r.sel);
    expect(bars).toEqual(['.rail', '.sidebar', '.conv-header', '.panel-head']);
    // The strip itself takes it, like the offline strip, and none when empty.
    const bodyOf = (sel) => rules.find((r) => r.sel === sel)?.body || '';
    expect(bodyOf('.transfer-strip')).toContain('padding-top: calc(5px + var(--safe-t))');
    expect(bodyOf('.transfer-strip:empty, .offline-banner:empty')).toContain('padding: 0');
    // Under a showing strip, every bar adds none.
    const underStrip = zeroing('.app-frame:has(> .transfer-strip:not(:empty))');
    expect(underStrip).toBeTruthy();
    for (const bar of bars) expect(underStrip.sel).toContain(bar);
    // Under a showing top bar (wide screens), every bar and the strip add none.
    const underTopbar = zeroing('.app-frame:has(> .topbar:not([hidden]))');
    expect(underTopbar).toBeTruthy();
    for (const bar of [...bars, '.transfer-strip']) expect(underTopbar.sel).toContain(bar);
    // And under the offline strip, which sits above the whole frame, the frame itself is told.
    expect(zeroing('body:has(> .offline-banner:not(:empty)) .app-frame')).toBeTruthy();
  });
});

describe('the reply box on a Threads card while the workspace changes under it', () => {
  const WORDS = 'This workspace is being moved to another server. You can read, but nothing can be posted for a few minutes.';

  it('gives way to the reason when replies can no longer go, keeps what was typed, and comes back when they can, as the thread panel does', async () => {
    const root = { seq: 1, user: 'u-dan', ts: 1000, text: 'the root of it', kind: 'msg', replyCount: 0 };
    const ctx = await boot({
      hash: `#/ws/${encodeURIComponent(REF)}/threads`,
      routes: {
        '/threads': () => json({ threads: [{ id: 'c1_t1', conv: 'c1', seq: 1, at: 2000, unread: 0, root }] }),
        '/messages': () => json({ messages: [], seq: 0 }),
      },
    });
    const { store, dom: d } = ctx;
    ctx.open();
    const { createListView } = await import('../src/ui/views.js');
    const view = createListView('threads');
    document.body.append(view.el);
    await d.tick(10);
    const card = () => view.el.querySelector('.thread-card');
    expect(card()).not.toBeNull();
    const box = card().querySelector('textarea');
    expect(box).not.toBeNull(); // replies can go: the card has its box
    d.type(box, 'half a reply');
    store.emit('workspace'); // a poll with nothing new: the box stays as it is
    await d.tick(5);
    expect(card().querySelector('textarea')).toBe(box);
    // The workspace begins moving to another server: the box gives way to the words, as the composer's and the panel's do.
    store.ws.transferring = { by: 'u-dan', at: store.serverNow() };
    store.emit('workspace');
    await d.tick(5);
    expect(card().querySelector('textarea')).toBeNull();
    expect(card().querySelector('.thread-card-blocked')?.textContent).toBe(WORDS);
    // The move completes: the box is back, the same one, with the half-typed reply still in it.
    store.ws.transferring = null;
    store.emit('workspace');
    await d.tick(5);
    expect(card().querySelector('.thread-card-blocked')).toBeNull();
    expect(card().querySelector('textarea')).toBe(box);
    expect(box.value).toBe('half a reply');
    // A channel archived under the card says so the same way.
    store.ws.channels.c1.archived = true;
    store.emit('workspace');
    await d.tick(5);
    expect(card().querySelector('.thread-card-blocked')?.textContent).toBe('This channel is archived');
    view.destroy();
  });
});

describe('the tab rows over the search results and the Directory', () => {
  const selected = (root) => root.querySelector('.conv-tab[aria-selected="true"] span').textContent;

  it('let a modified arrow pass (the browser\'s Back and Forward), and an arrow typed into an IME, and still take the bare one', async () => {
    const hit = (seq) => ({ conv: 'c1', seq, ts: 1000 + seq, user: 'u-dan', text: `ops ${seq}`, kind: 'msg' });
    const { open, dom: d } = await boot({
      hash: `#/ws/${encodeURIComponent(REF)}/search/ops`,
      routes: { '/search': () => json({ results: [hit(1)], indexed: true }) },
    });
    open();
    const { createSearchView } = await import('../src/ui/search.js');
    const view = createSearchView('ops', { onQuery() {} });
    document.body.append(view.el);
    await d.tick(5);
    const tabs = view.el.querySelector('.search-tabs');
    tabs.querySelector('[aria-selected="true"]').focus();
    expect(selected(view.el)).toBe('Messages');
    for (const mod of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }]) {
      expect(d.key(document.activeElement, 'ArrowRight', mod).defaultPrevented).toBe(false);
      expect(selected(view.el)).toBe('Messages');
    }
    expect(d.key(document.activeElement, 'ArrowRight').defaultPrevented).toBe(true);
    expect(selected(view.el)).toBe('Files');
    expect(document.activeElement).toBe(tabs.querySelector('[aria-selected="true"]'));
    view.destroy();

    const { createDirectoryView } = await import('../src/ui/directory.js');
    const dir = createDirectoryView();
    document.body.append(dir.el);
    await d.tick(5);
    const dirTabs = dir.el.querySelector('.dir-tabs');
    dirTabs.querySelector('[aria-selected="true"]').focus();
    expect(selected(dir.el)).toBe('People');
    for (const mod of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }]) {
      expect(d.key(document.activeElement, 'ArrowLeft', mod).defaultPrevented).toBe(false);
      expect(selected(dir.el)).toBe('People');
    }
    expect(d.key(document.activeElement, 'ArrowLeft').defaultPrevented).toBe(true);
    expect(selected(dir.el)).toBe('Channels');
    expect(document.activeElement).toBe(dirTabs.querySelector('[aria-selected="true"]'));
    dir.destroy();
  });
});

describe('the app opened without a network and without the Puter SDK', () => {
  /** Wait for a condition rather than a fixed pause, up to a generous bound. */
  const until = async (fn, ms = 12_000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await dom.tick(25); } };

  it('lands on "Could not reach Puter" quickly, asks for the SDK again when the network is back, and comes up without a reload', async () => {
    dom?.uninstall();
    dom = installDom({ hash: '' });
    vi.resetModules();
    const app = document.createElement('div');
    app.id = 'app';
    app.className = 'app';
    document.body.append(app);
    // The page's own SDK tag, which failed to load.
    const tag = document.createElement('script');
    tag.setAttribute('src', 'https://js.puter.com/v2/');
    document.head.append(tag);
    dom.navigator.onLine = false;
    delete globalThis.puter;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    await import('../src/main.js');
    await until(() => app.querySelector('.auth-title')?.textContent === 'Could not reach Puter');
    expect(Date.now() - t0).toBeLessThan(5500); // offline, the wait for a script that cannot load is short (it was six seconds)
    expect(document.querySelectorAll('.offline-banner').length).toBe(1);
    expect(document.querySelector('.offline-banner').textContent).toBe('You are offline.');
    expect(document.querySelectorAll('script[src*="js.puter.com"]').length).toBe(1);
    // The network is back: the SDK is asked for afresh, since the browser does not retry the tag that failed.
    dom.navigator.onLine = true;
    window.dispatchEvent(new Event('online'));
    await dom.tick(5);
    const tags = document.querySelectorAll('script[src*="js.puter.com"]');
    expect(tags.length).toBe(2);
    expect(tags[1].getAttribute('src')).toBe('https://js.puter.com/v2/');
    expect(app.querySelector('.auth-title')?.textContent).toBe('Could not reach Puter'); // still waiting for it
    // It loads: the app comes up in the page's place.
    globalThis.puter = { auth: { isSignedIn: async () => true, getUser: async () => ({ uuid: 'u-me', username: 'me' }) }, kv: { get: async () => null } };
    await until(() => !!app.querySelector('.app-frame'));
    expect(dom.location.reloads).toBe(0);
    // The network flickering again asks for nothing more.
    window.dispatchEvent(new Event('online'));
    await dom.tick(30);
    expect(app.querySelectorAll('.app-frame').length).toBe(1);
    expect(document.querySelectorAll('script[src*="js.puter.com"]').length).toBe(2);
    quiet.mockRestore();
    delete globalThis.puter;
  }, 15_000);
});

describe('the offline strip outside the app', () => {
  it('says only that the reader is offline, with no stray word where the note about messages would go', async () => {
    const { dom: d } = await boot();
    const { mountOfflineBanner } = await import('../src/ui/offline.js');
    d.navigator.onLine = false;
    // As main.js mounts it before sign-in: the note applies only once the app frame is on the page.
    const { el: strip } = mountOfflineBanner({ note: () => !!document.querySelector('.app-frame') });
    expect(strip.textContent).toBe('You are offline.');
    expect(strip.querySelector('.offline-note')).toBeNull();
    expect([...strip.childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.localName)).toEqual(['span', 'span']);
    // Back, then gone again once the app is up: the note is there this time.
    d.navigator.onLine = true;
    window.dispatchEvent(new Event('online'));
    expect(strip.textContent).toBe('');
    const frame = document.createElement('div');
    frame.className = 'app-frame';
    document.body.append(frame);
    d.navigator.onLine = false;
    window.dispatchEvent(new Event('offline'));
    expect(strip.textContent).toBe('You are offline. Messages you send will go out when you are back.');
    expect(strip.querySelector('.offline-note')).not.toBeNull();
  });
});
