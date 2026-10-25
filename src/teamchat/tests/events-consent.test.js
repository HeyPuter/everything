/**
 * The owner-facing consent surface for events signalling, both halves of
 * it: the toast (src/ui/shell.js, maybeOfferEventsConsent), offered once per
 * workspace but only once GET /api/server gives a definite answer, and the
 * "Live updates" row Workspace settings shows beside it (src/ui/dialogs.js,
 * workspaceSettingsDialog and liveUpdatesState), which carries the same
 * switch for an owner who waved the toast away. Driven the way
 * tests/ui-shell-pass16.test.js drives the shell: a fake DOM
 * (tests/helpers/dom.js), conversation.js and huddle.js mocked out, later
 * 'workspace' emits fired directly on the store rather than through a real
 * bootstrap.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Each test here mounts the whole shell afresh through the fake DOM and
// waits on its ticks; under several test runs at once (six review gates on
// one machine) five of them ran past the default five seconds that they
// clear easily alone. Room, not a weaker check.
vi.setConfig({ testTimeout: 20_000 });
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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;

/**
 * A fresh DOM and fresh modules, the store opened as the workspace's own
 * owner. `server` answers every GET/PUT /api/server; swap it mid-test with
 * the returned `setServer` to change what a later look finds. `permsCheck`
 * is what `puter.perms.check` answers (default: not held, so a test that
 * never mentions it sees exactly the pre-healing behaviour); pass `null` to
 * drop `perms.check` off the fake entirely, as an SDK that predates it would.
 */
async function boot({
  server = () => json({ owner: true, events: { appUid: 'app-teamchat-test', why: 'unknown' } }),
  permsCheck = async () => false,
} = {}) {
  dom?.uninstall();
  dom = installDom({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
  vi.resetModules();
  const calls = [];
  let answer = server;
  const perms = { request: vi.fn(async () => true) };
  if (permsCheck !== null) perms.check = vi.fn(permsCheck);
  globalThis.puter = {
    appID: 'app-teamchat-test',
    perms,
    workers: {
      exec: async (url, init = {}) => {
        const u = new URL(url);
        calls.push(`${init.method || 'GET'} ${u.pathname}`);
        if (u.pathname.endsWith('/api/server')) return answer(init);
        return json({ code: 'not_found', message: 'nope' }, 404);
      },
    },
  };
  const { store } = await import('../src/lib/store.js');
  const open = () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = {
      id: 'abc123def0', name: 'Globex', owner: 'u-me',
      channels: { c1: { id: 'c1', name: 'general', def: true } },
      members: { 'u-me': { role: 'owner', name: 'Me', username: 'me' } },
    };
    store.me = {
      role: 'owner', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {},
    };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    store.workspaces = [{ id: REF, name: 'Globex' }];
  };
  store.openWorkspace = async () => { open(); store.emit('workspace'); };
  store.startPolling = () => {};
  store.pokeSync = () => {};
  return {
    store,
    dom,
    setServer: (fn) => { answer = fn; },
    serverCalls: () => calls.filter((c) => c.endsWith('/api/server')).length,
    calls: () => [...calls],
  };
}

afterEach(() => {
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
  vi.useRealTimers();
});

/** The shell mounted and settled, at the workspace's own owner. */
async function shell(opts = {}) {
  const ctx = await boot(opts);
  const { mountShell } = await import('../src/ui/shell.js');
  const app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  mountShell(app);
  await ctx.dom.tick(5);
  return { ...ctx, app };
}

const toasts = () => document.querySelectorAll('.toast').length;
const past = () => { vi.setSystemTime(Date.now() + 61_000); }; // past EV_CONSENT_RECHECK_MS

describe('the events consent toast', () => {
  it('does not toast on an inconclusive "unknown" look, and does once a later look is definite', async () => {
    let call = 0;
    const ctx = await shell({
      server: () => {
        call++;
        return call === 1
          ? json({ owner: true, events: { appUid: 'app-teamchat-test', why: 'unknown' } })
          : json({ owner: true, events: { appUid: 'app-teamchat-test', why: 'events_kv_handle_not_delegated', delegated: false } });
      },
    });
    expect(ctx.serverCalls()).toBe(1);
    expect(toasts()).toBe(0);
    past();
    ctx.store.emit('workspace');
    await ctx.dom.tick(5);
    expect(ctx.serverCalls()).toBe(2);
    expect(toasts()).toBe(1);
  });

  it('throttles: several emits inside the recheck window cost exactly one GET', async () => {
    const ctx = await shell();
    expect(ctx.serverCalls()).toBe(1);
    ctx.store.emit('workspace');
    ctx.store.emit('workspace');
    ctx.store.emit('workspace');
    await ctx.dom.tick(5);
    expect(ctx.serverCalls()).toBe(1); // the 'unknown' look was inconclusive, but the window has not passed
  });

  it('a throw leaves a later emit free to try again', async () => {
    let call = 0;
    const ctx = await shell({
      server: () => {
        call++;
        if (call === 1) throw new Error('offline');
        return json({ owner: true, events: { appUid: 'app-teamchat-test', why: 'events_kv_handle_not_delegated', delegated: false } });
      },
    });
    expect(ctx.serverCalls()).toBe(1);
    expect(toasts()).toBe(0);
    past();
    ctx.store.emit('workspace');
    await ctx.dom.tick(5);
    expect(ctx.serverCalls()).toBe(2);
    expect(toasts()).toBe(1);
  });

  it('a definite answer latches for good: one GET, no toast, and no second GET however many emits follow', async () => {
    const ctx = await shell({ server: () => json({ owner: true, events: { appUid: 'app-teamchat-test', why: null, delegated: true } }) });
    expect(ctx.serverCalls()).toBe(1);
    expect(toasts()).toBe(0);
    past();
    ctx.store.emit('workspace');
    ctx.store.emit('workspace');
    await ctx.dom.tick(5);
    expect(ctx.serverCalls()).toBe(1); // latched: not even asked again once the window has passed
    expect(toasts()).toBe(0);
  });

  // A member who is not the worker's own owner is told nothing about the
  // events question at all (GET /api/server keeps that to the owner), which
  // is as definite an answer as there is: asking again every minute for the
  // rest of the session would be one request a minute for nothing, on every
  // tab in the workspace but the owner's.
  it('someone who is not the worker\'s owner is asked once and never again', async () => {
    const ctx = await shell({ server: () => json({ owner: false }) });
    expect(ctx.serverCalls()).toBe(1);
    past();
    ctx.store.emit('workspace');
    await ctx.dom.tick(5);
    expect(ctx.serverCalls()).toBe(1);
    expect(toasts()).toBe(0);
  });

  it('offers the toast and asks for the right permission on the happy path', async () => {
    const ctx = await shell({ server: () => json({ owner: true, events: { appUid: 'app-teamchat-test', why: 'events_kv_handle_not_delegated', delegated: false } }) });
    expect(toasts()).toBe(1);
    document.querySelector('.toast .toast-action').click();
    await ctx.dom.tick(5);
    expect(globalThis.puter.perms.request).toHaveBeenCalledWith('permission', { permission: 'manage:kv-share:u-me:app-teamchat-test:tc:ws' });
  });
});

describe('liveUpdatesState: what the "Live updates" row in Workspace settings shows', () => {
  // dialogs.js touches `document` at import time, so the DOM has to be
  // installed (via boot()) before it can be imported.
  async function state(info, appUid = 'app-teamchat-test') {
    await boot();
    const { liveUpdatesState } = await import('../src/ui/dialogs.js');
    return liveUpdatesState(info, appUid);
  }

  it('a server too old to carry an events key at all is unavailable, with nothing to press', async () => {
    expect(await state({})).toMatchObject({ state: 'old_worker', canTurnOn: false });
  });

  it('a worker with no app identity is unavailable, with nothing to press', async () => {
    const r = await state({ events: { appUid: null, delegated: false, why: 'no_app_uid' } });
    expect(r).toMatchObject({ state: 'no_app_uid', canTurnOn: false });
    expect(r.detail).toBe('Unavailable: this server was not created by Teamchat, so it cannot reach anyone’s tabs. Deploying a new server from Teamchat is what turns this on.');
  });

  it('the platform having the feature off is unavailable, under either of the two codes that say so', async () => {
    for (const why of ['events_disabled', 'events_kv_handles_disabled']) {
      expect(await state({ events: { appUid: 'app-teamchat-test', delegated: false, why } })).toMatchObject({ state: 'platform_off', canTurnOn: false });
    }
  });

  // Checked before a delegated "on": a tab running as a different app than
  // the server is refused altogether, so calling it "on" here would be a lie.
  it('a tab running as a different app than the server is unavailable, whatever the server itself answered', async () => {
    const r = await state({ events: { appUid: 'app-server', delegated: false, why: 'events_kv_handle_not_delegated' } }, 'app-tab');
    expect(r).toMatchObject({ state: 'app_mismatch', canTurnOn: false });
  });

  it('a delegated handle is on, with nothing left to press', async () => {
    const r = await state({ events: { appUid: 'app-teamchat-test', delegated: true, why: null } });
    expect(r).toMatchObject({ state: 'on', canTurnOn: false });
    expect(r.detail).toBe('');
  });

  it('the owner\'s own handle cap being full is paused, not something pressing again fixes', async () => {
    const r = await state({ events: { appUid: 'app-teamchat-test', delegated: false, why: 'events_kv_handle_limit_reached' } });
    expect(r).toMatchObject({ state: 'limit', canTurnOn: false });
  });

  it('an owner whose email is not confirmed is paused, not asked for a permission that would not help', async () => {
    const r = await state({ events: { appUid: 'app-teamchat-test', delegated: false, why: 'account_is_not_verified' } });
    expect(r).toMatchObject({ state: 'unverified', canTurnOn: false });
  });

  // 'unknown' (nothing has tripped a refusal yet) and a real refusal share
  // this branch on purpose: the owner's action is the same either way.
  it('a plain refusal, or nothing probed yet, both need the owner\'s permission', async () => {
    for (const why of ['events_kv_handle_not_delegated', 'unknown', 'events_kv_handle_owner_only']) {
      expect(await state({ events: { appUid: 'app-teamchat-test', delegated: false, why } })).toMatchObject({ state: 'consent', canTurnOn: true });
    }
  });
});

describe('the "Live updates" row in Workspace settings', () => {
  it('renders for the owner, filled in once GET /api/server answers', async () => {
    const ctx = await boot({ server: () => json({ owner: true, events: { appUid: 'app-teamchat-test', delegated: true, why: null } }) });
    await ctx.store.openWorkspace();
    const { workspaceSettingsDialog } = await import('../src/ui/dialogs.js');
    workspaceSettingsDialog();
    await ctx.dom.tick(5);
    const row = [...document.querySelectorAll('.details-row')].find((r) => r.textContent.includes('Live updates'));
    expect(row).toBeTruthy();
    expect(row.querySelector('.details-text').textContent).toBe('Live updates');
    expect(row.querySelector('.details-text').lastChild.hidden).toBe(true);
  });

  it('does not render at all for a non-owner', async () => {
    const ctx = await boot();
    await ctx.store.openWorkspace();
    ctx.store.ws.owner = 'someone-else';
    const { workspaceSettingsDialog } = await import('../src/ui/dialogs.js');
    workspaceSettingsDialog();
    await ctx.dom.tick(5);
    expect([...document.querySelectorAll('.details-row')].some((r) => r.textContent.includes('Live updates'))).toBe(false);
    expect(ctx.serverCalls()).toBe(0); // a non-owner's own dialog never asks
  });
});

describe('Turn on: the same switch the toast offers, reachable any time from Workspace settings', () => {
  async function openWithRow(server) {
    const ctx = await boot({ server });
    await ctx.store.openWorkspace();
    const { workspaceSettingsDialog } = await import('../src/ui/dialogs.js');
    workspaceSettingsDialog();
    await ctx.dom.tick(5);
    const row = [...document.querySelectorAll('.details-row')].find((r) => r.textContent.includes('Live updates'));
    return { ...ctx, row, button: row.querySelector('button') };
  }

  const needsConsent = () => json({ owner: true, events: { appUid: 'app-teamchat-test', delegated: false, why: 'events_kv_handle_not_delegated' } });

  it('grants the permission, tells the worker, and forgets a declined toast', async () => {
    const ctx = await openWithRow(needsConsent);
    const updatePrefs = vi.spyOn(ctx.store, 'updatePrefs').mockResolvedValue({});
    expect(ctx.button).toBeTruthy();
    ctx.button.focus();
    ctx.button.click();
    await ctx.dom.tick(5);
    expect(globalThis.puter.perms.request).toHaveBeenCalledWith('permission', { permission: 'manage:kv-share:u-me:app-teamchat-test:tc:ws' });
    expect(ctx.calls()).toContain('PUT /api/server');
    expect(updatePrefs).toHaveBeenCalledWith({ evConsent: null });
    expect(ctx.row.textContent).toContain('On: your permission is in.');
    // Gone, and not left mid-press behind its own hidden attribute: a
    // disabled button still reading "Turning on" is what the keyboard would
    // come back to.
    expect(ctx.row.querySelector('button').hidden).toBe(true);
    expect(ctx.row.querySelector('button').disabled).toBe(false);
    expect(ctx.row.querySelector('button').textContent).toBe('Turn on');
    // And the keyboard is still in the dialog rather than out on the page
    // body, where hiding the control it rests on would otherwise drop it.
    expect(document.querySelector('.modal-panel').contains(document.activeElement)).toBe(true);
  });

  it('declined in Puter’s own dialog leaves everything as it was', async () => {
    const ctx = await openWithRow(needsConsent);
    globalThis.puter.perms.request = vi.fn(async () => false);
    const updatePrefs = vi.spyOn(ctx.store, 'updatePrefs');
    ctx.button.click();
    await ctx.dom.tick(5);
    expect(ctx.calls()).not.toContain('PUT /api/server');
    expect(updatePrefs).not.toHaveBeenCalled();
    expect(ctx.row.querySelector('button').hidden).toBe(false);
    expect(ctx.row.querySelector('button').disabled).toBe(false);
    expect(toasts()).toBe(0);
  });

  it('a thrown request restores the button and shows one plain toast, nothing else changed', async () => {
    const ctx = await openWithRow(needsConsent);
    globalThis.puter.perms.request = vi.fn(async () => { throw new Error('offline'); });
    ctx.button.click();
    await ctx.dom.tick(5);
    expect(ctx.calls()).not.toContain('PUT /api/server');
    const button = ctx.row.querySelector('button');
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(toasts()).toBe(1);
  });
});
