import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';
import { fixture, clip, onMain, s } from './helpers.js';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { projectDuration, mainTrack as mainTrackOf } from '../src/model/timeline.js';
import { createCompound } from '../src/model/compound.js';
import { createThreadList } from '../src/ui/review/threads.js';
import { ReviewPage, cleanReviewHash } from '../src/ui/review/review-page.js';
import { createReviewPanel, reviewMarkers } from '../src/ui/review/review-panel.js';
import { openShareDialog, appBase } from '../src/ui/review/share-dialog.js';
import { shareForReview, reviewSettings, reviewSource, reviewFilePath, REVIEW_PRESET } from '../src/review/share.js';
import { ReviewSession } from '../src/review/session.js';
import { parseReviewHash } from '../src/review/protocol.js';
import { WORKER_KEY, call as callWorker } from '../src/review/api.js';
import axe from 'axe-core';

/** Serious and critical axe violations (layout-dependent rules off in jsdom). */
async function violations(node) {
  const result = await axe.run(node, { resultTypes: ['violations'], rules: { 'color-contrast': { enabled: false }, 'scrollable-region-focusable': { enabled: false } } });
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeAll(() => {
  // jsdom has no media playback: a stand-in that seeks at once and fires its events later, as browsers do.
  const later = (el, type) => queueMicrotask(() => el.dispatchEvent(new Event(type)));
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() {
    return this._paused !== false;
  } });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() {
    return this._time || 0;
  }, set(v) {
    this._time = v;
    later(this, 'seeked');
  } });
  HTMLMediaElement.prototype.play = function play() {
    this._paused = false;
    later(this, 'play');
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {
    if (this._paused === false) later(this, 'pause');
    this._paused = true;
  };
  HTMLMediaElement.prototype.load = function load() {};
  // The app loads the worker bundle it deploys; here it is a stub with the build the fake worker reports.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('worker/video-studio-review-worker.js') ? new Response('/* video-studio-review-worker build=dev at=1 */') : realFetch(url, init));
  if (!globalThis.CSS) globalThis.CSS = {};
  if (!CSS.escape) CSS.escape = (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  HTMLFormElement.prototype.requestSubmit ??= function requestSubmit() {
    this.dispatchEvent(new Event('submit', { cancelable: true }));
  };
});

afterEach(() => {
  document.body.replaceChildren();
  for (const d of document.querySelectorAll('dialog')) d.remove();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const btn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const fakeExport = (calls = []) => async (project, library, settings, opts) => {
  calls.push({ project, settings });
  opts.onProgress?.({ fraction: 0.5 });
  opts.onProgress?.({ fraction: 1 });
  const dur = projectDuration(project);
  return { blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), duration: dur, width: 1280, height: 720, release: () => calls.push('released') };
};
const caps = async () => ({ video: ['avc'], audio: ['aac'], audioFormats: ['wav'] });

function projectWithClips() {
  const p = fixture();
  p.id = 'proj_ui0001';
  p.name = 'Launch film';
  onMain(p, clip('video', 0, 10));
  return p;
}

describe('thread list', () => {
  const me = { uuid: 'u-bob', username: 'bob' };
  const thread = (f = {}) => ({ id: 'c_one0001', version: 1, parent: null, text: 'Too dark', t: 2_000_000, end: null, author: me, created: Date.now(), seq: 1, resolved: false, deleted: false, replies: [], ...f });

  it.each(['Reply', 'Edit'].flatMap((mode) => ['Escape', 'Enter'].map((key) => [mode, key])))('preserves the %s draft when composition uses %s', async (mode, key) => {
    const onReply = vi.fn(async () => {}), onEdit = vi.fn(async () => {});
    const list = createThreadList({ onReply, onEdit });
    document.body.append(list.el);
    list.update([thread()], { fps: 30, me, role: 'commenter' });
    btn(list.el, mode).click();
    const input = list.el.querySelector('textarea');
    input.value = 'Draft';
    input.dispatchEvent(new Event('input'));
    input.focus();
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const e = new KeyboardEvent('keydown', { key, ctrlKey: key === 'Enter', bubbles: true, cancelable: true, ...composition });
      input.dispatchEvent(e);
      expect(input.isConnected).toBe(true);
      expect(e.defaultPrevented).toBe(false);
      expect(onReply).not.toHaveBeenCalled();
      expect(onEdit).not.toHaveBeenCalled();
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    expect(mode === 'Reply' ? onReply : onEdit).toHaveBeenCalledTimes(1);
  });

  it('does not submit an edit twice while its save is pending, including after sync', async () => {
    let finish;
    const onEdit = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const list = createThreadList({ onEdit });
    document.body.append(list.el);
    const opts = { fps: 30, me, role: 'commenter' };
    list.update([thread()], opts);
    btn(list.el, 'Edit').click();
    const input = list.el.querySelector('textarea');
    input.value = 'Corrected';input.dispatchEvent(new Event('input'));
    const submit = () => list.el.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    submit();
    submit();
    expect(onEdit).toHaveBeenCalledTimes(1);
    list.update([thread({ resolved: true })], opts);
    expect(btn(list.el, 'Save').disabled).toBe(true);
    submit();
    expect(onEdit).toHaveBeenCalledTimes(1);
    finish();await tick();
    expect(list.el.querySelector('textarea')).toBe(null);
  });

  it.each(['Reply', 'Edit'])('retains a pending %s draft across sync and lets a failed save retry', async (mode) => {
    let fail;
    const send = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue(undefined);
    const list = createThreadList({ onReply: send, onEdit: send });
    document.body.append(list.el);
    const opts = { fps: 30, me, role: 'commenter' };
    list.update([thread()], opts);
    btn(list.el, mode).click();
    let input = list.el.querySelector('textarea');
    input.value = 'Keep this draft';input.dispatchEvent(new Event('input'));input.focus();
    input.closest('form').requestSubmit();
    expect(input.isConnected).toBe(true);
    expect(input.readOnly).toBe(true);
    list.update([thread({ resolved: true })], opts);
    input = list.el.querySelector('textarea');
    expect(input.value).toBe('Keep this draft');
    expect(input.readOnly).toBe(true);
    expect(btn(input.closest('form'), 'Cancel').disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(input.isConnected).toBe(true);
    input.closest('form').requestSubmit();
    expect(send).toHaveBeenCalledTimes(1);
    fail(new Error('Offline'));await tick();
    input = list.el.querySelector('textarea');
    expect(input.value).toBe('Keep this draft');
    expect(input.readOnly).toBe(false);
    expect(list.el.querySelector('.rv-form-error').textContent).toBe('Offline');
    expect(input.closest('form').querySelector('[type="submit"]').disabled).toBe(false);
    input.closest('form').requestSubmit();await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(list.el.querySelector('textarea')).toBe(null);
  });

  it('shows time, author, text and replies, and seeks on the time', () => {
    const onSeek = vi.fn();
    const list = createThreadList({ onSeek });
    document.body.append(list.el);
    list.update([thread({ replies: [{ ...thread(), id: 'c_rep0001', parent: 'c_one0001', text: 'Agreed', t: null, author: { uuid: 'u-al', username: 'alice' } }] })], { fps: 25, me, role: 'commenter' });
    expect(list.el.querySelector('.rv-time').textContent).toBe('00:00:02:00');
    expect(list.el.querySelector('.rv-author').textContent).toBe('bob');
    expect(list.el.querySelectorAll('.rv-reply').length).toBe(1);
    list.el.querySelector('.rv-time').click();
    expect(onSeek).toHaveBeenCalledWith(expect.objectContaining({ id: 'c_one0001' }));
    // Own comment: edit and delete; others' reply: neither.
    const [own, reply] = list.el.querySelectorAll('.rv-comment');
    expect(btn(own, 'Edit')).toBeTruthy();
    expect(btn(own, 'Delete')).toBeTruthy();
    expect(btn(reply, 'Edit')).toBeFalsy();
    expect(btn(reply, 'Delete')).toBeFalsy();
  });

  it('viewers get no reply or resolve; owners can delete anyone', () => {
    const list = createThreadList({});
    list.update([thread()], { fps: 30, me: { uuid: 'x', username: 'carol' }, role: 'viewer' });
    expect(btn(list.el, 'Reply')).toBeFalsy();
    expect(btn(list.el, 'Resolve')).toBeFalsy();
    list.update([thread()], { fps: 30, me: { uuid: 'own', username: 'alice' }, role: 'owner' });
    expect(btn(list.el, 'Delete')).toBeTruthy();
    expect(btn(list.el, 'Edit')).toBeFalsy();
  });

  it('keeps a reply draft across updates and sends it', async () => {
    const onReply = vi.fn(async () => {});
    const list = createThreadList({ onReply });
    document.body.append(list.el);
    const opts = { fps: 30, me, role: 'commenter' };
    list.update([thread()], opts);
    btn(list.el, 'Reply').click();
    const ta = list.el.querySelector('textarea');
    ta.value = 'Will fix';
    ta.dispatchEvent(new Event('input'));
    expect(list.editing).toBe(true);
    list.update([thread({ text: 'Too dark (synced)' })], opts);
    const again = list.el.querySelector('textarea');
    expect(again.value).toBe('Will fix');
    expect(document.activeElement).toBe(again);
    again.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'c_one0001' }), 'Will fix');
    expect(list.el.querySelector('textarea')).toBe(null);
  });

  it('refuses empty and overlong text in forms', async () => {
    const onEdit = vi.fn(async () => {});
    const list = createThreadList({ onEdit });
    document.body.append(list.el);
    list.update([thread()], { fps: 30, me, role: 'commenter' });
    btn(list.el, 'Edit').click();
    const ta = list.el.querySelector('textarea');
    ta.value = '   ';
    ta.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(onEdit).not.toHaveBeenCalled();
    expect(list.el.querySelector('.rv-form-error').textContent).toMatch(/Write something/);
  });
});

describe('share for review (owner flow)', () => {
  it('picks a 720p H.264 preset at the project frame rate, never upscaling', () => {
    const p = projectWithClips();
    p.settings = { ...p.settings, width: 1920, height: 1080, fps: 25 };
    expect(reviewSettings(p)).toMatchObject({ ...REVIEW_PRESET, resolution: 720, fps: 25 });
    // Where the browser cannot encode sound the copy is shared silent, not refused (there is no format to pick).
    expect(reviewSettings(p).audioOptional).toBe(true);
    p.settings = { ...p.settings, width: 640, height: 360 };
    expect(reviewSettings(p).resolution).toBe(360);
    expect(reviewSettings(p, { video: ['vp9'] })).toMatchObject({ codec: 'vp9', format: 'webm' });
    expect(reviewFilePath('proj_1', 'pub_x', 'mp4', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('video-studio/reviews/proj_1/20260102T030405-pub_x.mp4');
  });

  it('slices the in/out range and remembers it', () => {
    const p = projectWithClips();
    p.range = { in: s(2), out: s(6) };
    const r = reviewSource(p, 'range');
    expect(r.range).toEqual({ in: s(2), out: s(6) });
    expect(projectDuration(r.project)).toBe(s(4));
    expect(reviewSource(p, 'all').range).toBe(null);
  });

  it('renders, saves in the owner files and publishes; sharing again adds a version', async () => {
    const env = await setup();
    const p = projectWithClips();
    const calls = [];
    const deps = { exportProject: fakeExport(calls), detectCapabilities: caps };
    const phases = [];
    const r1 = await shareForReview({ puter: env.sdk.alice, project: p, library: null, title: 'Launch film', deps, onPhase: (ph) => phases.push(ph) });
    expect(r1.version).toBe(1);
    expect(new Set(phases)).toEqual(new Set(['server', 'render', 'save', 'publish']));
    expect(calls[0].settings).toMatchObject({ resolution: 720, codec: 'avc', format: 'mp4' });
    expect(calls).toContain('released');
    const files = [...env.world.storage.tables.get('files').keys()].filter((k) => k.includes('/reviews/'));
    expect(files[0]).toMatch(/^\/alice\/AppData\/video-studio\/video-studio\/reviews\/proj_ui0001\/\d{8}T\d{6}-pub_.+\.mp4$/);
    p.range = { in: s(1), out: s(4) };
    const r2 = await shareForReview({ puter: env.sdk.alice, project: p, library: null, scope: 'range', title: 'Launch film v2', deps });
    expect(r2.review.id).toBe(r1.review.id);
    expect(r2.version).toBe(2);
    expect(r2.review.versions[1]).toMatchObject({ range: { in: s(1), out: s(4) }, duration: s(3) });
  });

  it('removes the saved copy when the review server refuses the new version', async () => {
    const env = await setup();
    const p = projectWithClips();
    const deps = { exportProject: fakeExport(), detectCapabilities: caps };
    const reviewFiles = () => [...env.world.storage.tables.get('files').keys()].filter((k) => k.includes('/reviews/'));
    const r1 = await shareForReview({ puter: env.sdk.alice, project: p, library: null, title: 'Launch film', deps });
    expect(reviewFiles()).toHaveLength(1);
    // The review is full: every further share is refused, and each left a whole 720p copy in the owner's files.
    await env.sdk.alice.kv.set(`vsr:r:${r1.review.id}:vseq`, 50);
    await expect(shareForReview({ puter: env.sdk.alice, project: p, library: null, title: 'Launch film', deps })).rejects.toMatchObject({ status: 409 });
    expect(reviewFiles()).toHaveLength(1);
  });

  it('publishes nothing when cancelled while the copy is being saved, and removes the saved copy', async () => {
    const env = await setup();
    const p = projectWithClips();
    const ctl = new AbortController();
    const deps = { exportProject: fakeExport(), detectCapabilities: caps };
    const run = shareForReview({ puter: env.sdk.alice, project: p, library: null, title: 'Launch film', signal: ctl.signal, deps, onPhase: (ph) => ph === 'save' && ctl.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect((await env.as('alice')('review.find', { projectId: p.id })).review).toBe(null);
    expect([...env.world.storage.tables.get('files').keys()].filter((k) => k.includes('/reviews/'))).toEqual([]);
  });
});

describe('share dialog', () => {
  it('shares, creates an invite link, lists links and people, and removes someone', async () => {
    const env = await setup();
    const store = new EditorStore(projectWithClips());
    const ctx = { store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {}, review: { refresh: vi.fn(), toggle: vi.fn() } };
    const deps = { shareForReview: (o) => shareForReview({ ...o, deps: { exportProject: fakeExport(), detectCapabilities: caps } }), base: () => 'https://app.example/' };
    const dlg = openShareDialog(ctx, { deps });
    await until(() => btn(dlg.el, 'Share'));
    expect(dlg.el.querySelector('.rv-share-intro').textContent).toMatch(/720p review copy/);
    btn(dlg.el, 'Share').click();
    await until(() => !dlg.el.querySelector('.rv-access').hidden);
    expect(ctx.review.refresh).toHaveBeenCalled();
    await until(() => dlg.el.querySelector('.rv-row.empty'));
    btn(dlg.el, 'Create link').click();
    const input = await until(() => dlg.el.querySelector('input.rv-link'));
    const link = parseReviewHash(new URL(input.value).hash);
    expect(input.value.startsWith('https://app.example/#review=')).toBe(true);
    expect(link.server).toBe((await env.sdk.alice.kv.get(WORKER_KEY)).server);
    await until(() => dlg.el.querySelector('[aria-label="Invite links"] .rv-row:not(.empty)'));
    expect(dlg.el.querySelector('[aria-label="Invite links"]').textContent).toMatch(/Can comment.*0 joined/);
    // Bob joins with the link; reopening shows him and offers version 2.
    await env.as('bob')('join', { review: link.review, token: link.token });
    dlg.close();
    const again = openShareDialog(ctx, { deps });
    await until(() => btn(again.el, 'Share version 2'));
    const people = await until(() => [...again.el.querySelectorAll('[aria-label="People"] .rv-row')].find((r) => r.textContent.includes('bob')));
    // Role change.
    const sel = people.querySelector('select');
    sel.value = 'viewer';
    sel.dispatchEvent(new Event('change'));
    await until(() => env.world.calls.some((c) => c.op === 'member.role'));
    // Turn off the link.
    btn(again.el, 'Turn off').click();
    await until(() => again.el.querySelector('[aria-label="Invite links"] .rv-row.off'));
    // Remove bob (confirm dialog).
    people.querySelector('[aria-label="Remove bob"]').click();
    const confirm = await until(() => [...document.querySelectorAll('dialog')].find((x) => x.textContent.includes('lose access')));
    btn(confirm, 'Remove').click();
    await until(() => again.el.querySelector('[aria-label="People"] .rv-row.empty'));
    await expect(env.as('bob')('sync', { review: link.review, since: 0 })).rejects.toMatchObject({ status: 403 });
    again.close();
  });

  it('shows the role a person has after a role change fails', async () => {
    const env = await setup();
    const store = new EditorStore(projectWithClips());
    const pub = await publish(env, { projectId: store.project.id });
    await env.as('bob')('join', { review: pub.review.id, token: await invite(env, pub.review.id) });
    let refuse = false;
    const call = (p, server, input) => (refuse && input.op === 'member.role' ? Promise.reject(new Error('Try again.')) : callWorker(p, server, input));
    const ctx = { store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {} };
    const dlg = openShareDialog(ctx, { deps: { call } });
    const people = await until(() => [...dlg.el.querySelectorAll('[aria-label="People"] .rv-row')].find((r) => r.textContent.includes('bob')));
    const sel = people.querySelector('select');
    sel.value = 'viewer';
    sel.dispatchEvent(new Event('change'));
    await until(() => env.world.calls.some((c) => c.op === 'member.role'));
    await new Promise((r) => setTimeout(r, 20));
    refuse = true;
    sel.value = 'commenter';
    sel.dispatchEvent(new Event('change'));
    await until(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Try again.')));
    expect((await env.as('alice')('members', { review: pub.review.id })).members[0].role).toBe('viewer');
    expect(sel.value).toBe('viewer');
    dlg.close();
  });

  it('asks to sign in when Puter is not available', () => {
    const store = new EditorStore(projectWithClips());
    const onSignIn = vi.fn();
    const dlg = openShareDialog({ store, library: { backend: { kind: 'local' } }, account: { onSignIn } });
    expect(dlg.el.textContent).toMatch(/needs a Puter account/);
    btn(dlg.el, 'Sign in to Puter').click();
    expect(onSignIn).toHaveBeenCalled();
    dlg.close();
  });

  it('builds links from the app address without Puter query parameters', () => {
    expect(appBase('https://x.puter.site/index.html?puter.app_instance_id=1#project=p')).toBe('https://x.puter.site/index.html');
  });
});

describe('review page (reviewer flow)', () => {
  async function opened(role = 'commenter', { versions = 1 } = {}) {
    const env = await setup();
    let pub;
    for (let i = 0; i < versions; i++) pub = await publish(env, { duration: 10_000_000, fps: 25 });
    const token = await invite(env, pub.review.id, role);
    const root = document.createElement('div');
    document.body.append(root);
    history.replaceState(null, '', `/#review=${pub.review.id}&server=${new URL(env.server).host}&invite=${token}`);
    const page = new ReviewPage(root, { puter: env.sdk.bob, link: { review: pub.review.id, server: env.server, token }, interval: 60_000 });
    await until(() => root.querySelector('.rv-page'));
    return { env, page, root, rid: pub.review.id };
  }

  it.each(['success', 'failure'])('does not reopen a disposed review after late startup %s', async (outcome) => {
    const env = await setup();
    const pub = await publish(env);
    const token = await invite(env, pub.review.id);
    let finish, fail, ready = false;
    const gate = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    class SlowSession extends ReviewSession {
      async open(options) { await super.open(options); ready = true; await gate; }
    }
    const root = document.createElement('div');document.body.append(root);
    const page = new ReviewPage(root, { puter: env.sdk.bob, link: { review: pub.review.id, server: env.server, token }, Session: SlowSession });
    try {
      await until(() => ready);
      const start = vi.spyOn(page.session, 'start');
      page.dispose();root.textContent = 'Home';history.replaceState(null, '', '/#home');
      if (outcome === 'success') finish();else fail(new Error('Late open failure'));
      await tick();
      expect(root.textContent).toBe('Home');
      expect(location.hash).toBe('#home');
      expect(start).not.toHaveBeenCalled();
    } finally { page.dispose(); }
  });

  it('does not navigate after a disposed review finishes signing in', async () => {
    let finish;
    const onSignedIn = vi.fn();
    const puter = { env: 'web', auth: { isSignedIn: () => false, signIn: () => new Promise((resolve) => { finish = resolve; }) } };
    const root = document.createElement('div');document.body.append(root);
    const page = new ReviewPage(root, { puter, link: {}, onSignedIn });
    btn(root, 'Sign in with Puter').click();page.dispose();root.textContent = 'Home';finish();await tick();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(root.textContent).toBe('Home');
  });

  it('joins with the invite, drops the token from the address, and shows the review', async () => {
    const { env, page, root, rid } = await opened();
    expect(location.hash).toBe(cleanReviewHash(rid, env.server));
    expect(location.hash).not.toContain('invite');
    expect(root.querySelector('.rv-title').textContent).toBe('Cut A');
    expect(root.querySelector('.rv-sub').textContent).toBe('Shared by alice. Can comment.');
    expect(root.querySelector('.rv-duration').textContent).toBe('00:00:10:00');
    await until(() => page.video.getAttribute('src'));
    expect(page.video.src).toMatch(/token-read/);
    page.dispose();
  });

  it('comments at the current frame and with a range, shows markers, replies and resolves', async () => {
    const { env, page, root } = await opened();
    // Step to 2 s with the keyboard: L steps one frame, Shift+L ten.
    page.seek(2_000_000);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    expect(page.t).toBe(2_040_000);
    expect(root.querySelector('.rv-timecode').textContent).toBe('00:00:02:01');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(page.t).toBe(2_000_000);
    // C opens the comment box at this frame.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    const text = root.querySelector('.rv-compose-text');
    expect(document.activeElement).toBe(text);
    expect(root.querySelector('.rv-pin .rv-pin-time').textContent).toBe('00:00:02:00');
    text.value = 'Logo is cut off';
    text.dispatchEvent(new Event('input'));
    // Moving on keeps the pin while text is written.
    page.seek(5_000_000);
    expect(root.querySelector('.rv-pin .rv-pin-time').textContent).toBe('00:00:02:00');
    root.querySelector('.rv-composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => [...root.querySelectorAll('.rv-thread')].some((t) => !t.querySelector('.pending')));
    // A range comment from 5 s to 6 s.
    page.composer.startHere();
    const range = root.querySelector('#rv-range');
    range.checked = true;
    range.dispatchEvent(new Event('change'));
    page.seek(6_000_000);
    btn(root, 'Set end to current frame').click();
    text.value = 'Music too loud here';
    text.dispatchEvent(new Event('input'));
    root.querySelector('.rv-composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => root.querySelectorAll('.rv-thread').length === 2 && !root.querySelector('.rv-comment.pending'));
    const times = [...root.querySelectorAll('.rv-thread > .rv-comment .rv-time')].map((b) => b.textContent);
    expect(times).toEqual(['00:00:02:00', '00:00:05:00 to 00:00:06:00']);
    expect(root.querySelectorAll('.rv-mark').length).toBe(2);
    expect(root.querySelector('.rv-mark.range')).toBeTruthy();
    // Clicking a marker seeks there and highlights the thread.
    root.querySelector('.rv-mark').click();
    expect(page.t).toBe(2_000_000);
    expect(root.querySelector('.rv-thread.active .rv-text').textContent).toBe('Logo is cut off');
    // The owner sees both and replies; bob sees the reply after a sync.
    const owner = new ReviewSession({ puter: env.sdk.alice, server: page.session.server, review: page.session.id });
    await owner.open();
    expect([...owner.comments.values()].map((c) => c.t)).toEqual([2_000_000, 5_000_000]);
    await owner.addComment({ version: 1, parent: [...owner.comments.values()][0].id, text: 'Fixed in the next cut' });
    await page.session.sync();
    await until(() => root.querySelector('.rv-reply'));
    expect(root.querySelector('.rv-reply .rv-author').textContent).toBe('alice');
    // Resolve the first thread.
    btn(root.querySelector('.rv-thread'), 'Resolve').click();
    await until(() => root.querySelector('.rv-thread.resolved'));
    expect(root.querySelector('.rv-count').textContent).toBe('1 open, 1 resolved');
    root.querySelector('#rv-show-resolved').click();
    expect(root.querySelectorAll('.rv-thread').length).toBe(1);
    owner.dispose();
    page.dispose();
  });

  it('lets go of the comment\'s pinned time when another version is shown', async () => {
    const env = await setup();
    await publish(env, { duration: 10_000_000, fps: 25 });
    const pub = await publish(env, { duration: 4_000_000, fps: 25 });
    const token = await invite(env, pub.review.id);
    const root = document.createElement('div');
    document.body.append(root);
    const page = new ReviewPage(root, { puter: env.sdk.bob, link: { review: pub.review.id, server: env.server, token }, interval: 60_000 });
    await until(() => root.querySelector('.rv-page'));
    page.setVersion(1);
    page.seek(8_000_000);
    page.composer.startHere();
    const range = root.querySelector('#rv-range');
    range.checked = true;
    range.dispatchEvent(new Event('change'));
    const text = root.querySelector('.rv-compose-text');
    text.value = 'Cut here';
    text.dispatchEvent(new Event('input'));
    expect(root.querySelector('.rv-pin .rv-pin-time').textContent).toBe('00:00:08:00');
    // On the 4 second version the box keeps the words but pins to the frame shown, as a fresh comment does.
    page.setVersion(2);
    expect(text.value).toBe('Cut here');
    expect(range.checked).toBe(false);
    page.seek(2_000_000);
    expect(root.querySelector('.rv-pin .rv-pin-time').textContent).toBe('00:00:02:00');
    root.querySelector('.rv-composer').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => root.querySelector('.rv-thread') && !root.querySelector('.rv-comment.pending'));
    expect(root.querySelector('.rv-composer .rv-form-error').textContent).toBe('');
    expect([...page.session.comments.values()].map((c) => [c.version, c.t, c.end])).toEqual([[2, 2_000_000, null]]);
    page.dispose();
  });

  it('posts once with Ctrl+Enter', async () => {
    const { page, root } = await opened();
    const text = root.querySelector('.rv-compose-text');
    text.value = 'One comment';
    text.dispatchEvent(new Event('input'));
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await until(() => root.querySelector('.rv-thread') && !root.querySelector('.rv-comment.pending'));
    await tick();
    expect(root.querySelectorAll('.rv-thread').length).toBe(1);
    expect(root.querySelector('.rv-composer .rv-form-error').textContent).toBe('');
    page.dispose();
  });

  it('keeps a newer draft and range when an earlier comment finishes posting', async () => {
    const { page, root } = await opened();
    try {
      let finish;
      const add = vi.spyOn(page.session, 'addComment').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const text = root.querySelector('.rv-compose-text'), form = text.closest('form');
      page.seek(s(1));text.value = 'First';text.dispatchEvent(new Event('input'));
      form.requestSubmit();
      page.seek(s(5));page.composer.startHere();
      text.value = 'Second';text.dispatchEvent(new Event('input'));
      const range = root.querySelector('#rv-range');range.checked = true;range.dispatchEvent(new Event('change'));
      page.seek(s(7));btn(root, 'Set end to current frame').click();
      finish({});await tick();
      expect(text.value).toBe('Second');
      expect(page.pin).toMatchObject({ t: s(5), end: s(7), held: true });
      expect(range.checked).toBe(true);
      expect(root.querySelector('.rv-composer .rv-form-error').textContent).toBe('');
    } finally { page.dispose(); }
  });

  it('ignores a second composer submission while its post is pending', async () => {
    const { page, root } = await opened();
    try {
      let finish;
      const add = vi.spyOn(page.session, 'addComment').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const text = root.querySelector('.rv-compose-text');
      text.value = 'First';text.dispatchEvent(new Event('input'));text.closest('form').requestSubmit();
      text.value = 'Next draft';text.dispatchEvent(new Event('input'));
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      expect(add).toHaveBeenCalledTimes(1);
      finish({});await tick();
    } finally { page.dispose(); }
  });

  it('keeps both drafts when an earlier post fails and retries its original version and range', async () => {
    const { page, root } = await opened('commenter', { versions: 2 });
    try {
      let fail;
      const add = vi.spyOn(page.session, 'addComment').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue({});
      await page.setVersion(1);page.seek(s(1));page.composer.startHere();
      const text = root.querySelector('.rv-compose-text'), form = text.closest('form');
      const range = root.querySelector('#rv-range');range.checked = true;range.dispatchEvent(new Event('change'));
      page.seek(s(3));btn(root, 'Set end to current frame').click();
      text.value = 'First draft';text.dispatchEvent(new Event('input'));form.requestSubmit();
      await page.setVersion(2);page.seek(s(5));page.composer.startHere();
      text.value = 'Newer draft';text.dispatchEvent(new Event('input'));
      fail(new Error('Offline'));await tick();
      expect(text.value).toBe('Newer draft');
      expect(page.pin).toMatchObject({ t: s(5), end: null, held: true });
      const failed = root.querySelector('.rv-unsent');
      expect(failed?.textContent).toContain('First draft');
      expect(failed?.textContent).toContain('Offline');
      btn(failed, 'Retry').click();await tick();
      expect(add).toHaveBeenLastCalledWith({ version: 1, text: 'First draft', t: s(1), end: s(3) });
      expect(root.querySelector('.rv-unsent')).toBe(null);
      expect(text.value).toBe('Newer draft');
    } finally { page.dispose(); }
  });

  it('restores an untouched failed draft with its original time range', async () => {
    const { page, root } = await opened();
    try {
      let fail;
      vi.spyOn(page.session, 'addComment').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
      page.seek(s(2));page.composer.startHere();
      const range = root.querySelector('#rv-range');range.checked = true;range.dispatchEvent(new Event('change'));
      page.seek(s(4));btn(root, 'Set end to current frame').click();
      const text = root.querySelector('.rv-compose-text');text.value = 'Keep me';text.dispatchEvent(new Event('input'));
      text.closest('form').requestSubmit();page.seek(s(8));
      fail(new Error('Offline'));await tick();
      expect(text.value).toBe('Keep me');
      expect(page.pin).toMatchObject({ t: s(2), end: s(4), held: true });
      expect(range.checked).toBe(true);
      expect(root.querySelector('.rv-unsent')).toBe(null);
    } finally { page.dispose(); }
  });

  it('keeps a failed retry available and discards it without changing the current draft', async () => {
    const { page, root } = await opened();
    try {
      let fail;
      const add = vi.spyOn(page.session, 'addComment').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockRejectedValue(new Error('Still offline'));
      const text = root.querySelector('.rv-compose-text');
      text.value = 'Unsent';text.dispatchEvent(new Event('input'));text.closest('form').requestSubmit();
      text.value = 'Current';text.dispatchEvent(new Event('input'));
      fail(new Error('Offline'));await tick();
      const row = root.querySelector('.rv-unsent');
      btn(row, 'Retry').click();btn(row, 'Retry').click();
      expect(add).toHaveBeenCalledTimes(2);
      expect(btn(row, 'Discard').disabled).toBe(true);
      await tick();
      expect(row.textContent).toContain('Still offline');
      expect(btn(row, 'Retry').disabled).toBe(false);
      expect(await violations(row)).toEqual([]);
      btn(row, 'Discard').focus();btn(row, 'Discard').click();
      expect(row.isConnected).toBe(false);
      expect(text.value).toBe('Current');
      expect(document.activeElement === text).toBe(true);
    } finally { page.dispose(); }
  });

  it('pins the next draft to its own frame while the previous post is pending', async () => {
    const { page, root } = await opened();
    try {
      let finish;
      vi.spyOn(page.session, 'addComment').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const text = root.querySelector('.rv-compose-text');
      page.seek(s(1));text.value = 'First';text.dispatchEvent(new Event('input'));text.closest('form').requestSubmit();
      page.seek(s(5));text.value = 'Next';text.dispatchEvent(new Event('input'));
      expect(page.pin).toMatchObject({ t: s(5), held: true, end: null });
      finish({});await tick();
      expect(page.pin.t).toBe(s(5));
    } finally { page.dispose(); }
  });

  it.each(['Escape', 'Enter'])('keeps composition %s in the review composer', async (key) => {
    const { page, root } = await opened();
    try {
      const add = vi.spyOn(page.session, 'addComment').mockResolvedValue({});
      const input = root.querySelector('.rv-compose-text');
      input.value = 'Draft';input.dispatchEvent(new Event('input'));input.focus();
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        const e = new KeyboardEvent('keydown', { key, ctrlKey: key === 'Enter', bubbles: true, cancelable: true, ...composition });
        input.dispatchEvent(e);
        expect(document.activeElement === input).toBe(true);
        expect(input.value).toBe('Draft');
        expect(add).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
      }
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      await tick();
      expect(add).toHaveBeenCalledTimes(1);
    } finally { page.dispose(); }
  });

  it('stops polling and commenting once the owner removes someone', async () => {
    const { env, page, root, rid } = await opened();
    page.session.start(60_000);
    await env.as('alice')('member.remove', { review: rid, uuid: USERS.bob.uuid });
    await page.session.sync().catch(() => {});
    expect(page.session.polling).toBe(false);
    expect(root.querySelector('.rv-composer').hidden).toBe(true);
    expect(root.querySelector('.rv-sync').textContent).toMatch(/do not have access/);
    page.dispose();
  });

  it('viewers watch and read but have no comment box', async () => {
    const { page, root } = await opened('viewer');
    expect(root.querySelector('.rv-composer')).toBe(null);
    expect(root.textContent).toMatch(/You can watch this review/);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    page.dispose();
  });

  it('toggles a focused checkbox with Space instead of playing', async () => {
    const { page, root } = await opened();
    const box = root.querySelector('#rv-show-resolved');
    box.focus();
    const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    box.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(page.video.paused).toBe(true);
    // Elsewhere Space still plays, and J/K/L work with the checkbox focused.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(page.video.paused).toBe(false);
    page.video.pause();
    page.seek(2_000_000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    expect(page.t).toBe(2_040_000);
    page.dispose();
  });

  it('gives a viewer made a commenter the comment box at once', async () => {
    const { env, page, root, rid } = await opened('viewer');
    page.seek(2_000_000);
    await env.as('alice')('member.role', { review: rid, uuid: USERS.bob.uuid, role: 'commenter' });
    await page.session.sync();
    await until(() => page.session.role === 'commenter');
    expect(root.querySelector('.rv-composer')?.hidden).toBe(false);
    expect(root.querySelector('.rv-note').hidden).toBe(true);
    expect(root.querySelector('.rv-pin-time').textContent).toBe('00:00:02:00');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(document.activeElement).toBe(root.querySelector('.rv-composer textarea'));
    // And back: a viewer again loses it.
    await env.as('alice')('member.role', { review: rid, uuid: USERS.bob.uuid, role: 'viewer' });
    await page.session.sync();
    await until(() => page.session.role === 'viewer');
    expect(root.querySelector('.rv-composer').hidden).toBe(true);
    expect(root.querySelector('.rv-note').hidden).toBe(false);
    page.dispose();
  });

  it('stops on the last frame with End and at the end of playback', async () => {
    const { page, root } = await opened();
    page.strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(page.t).toBe(9_960_000);
    expect(root.querySelector('.rv-timecode').textContent).toBe('00:00:09:24');
    page.seek(0);
    page.video._time = 10;
    page.video._paused = false;
    page.video.pause();
    await until(() => page.t === 9_960_000);
    page.dispose();
  });

  it('offers a version picker and keeps comments with their version', async () => {
    const { env, page, root, rid } = await opened('commenter', { versions: 2 });
    const select = root.querySelector('.rv-version');
    expect(select.hidden).toBe(false);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Version 2 (latest)', 'Version 1']);
    await page.session.addComment({ version: 2, text: 'On v2', t: 0 });
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(page.version).toBe(1);
    expect(root.querySelectorAll('.rv-thread').length).toBe(0);
    // A new version shared while the page is open shows after a sync.
    await publish(env, { duration: 10_000_000, fps: 25 });
    await page.session.sync();
    await until(() => root.querySelector('.rv-version').options.length === 3);
    expect(root.querySelector('.rv-version').options[0].textContent).toMatch(/Version 3 \(latest\)/);
    expect(rid).toBeTruthy();
    page.dispose();
  });

  it('shows the comment\'s frame when it is on a version whose video is still loading', async () => {
    const { page } = await opened('commenter', { versions: 2 });
    const c = await page.session.addComment({ version: 1, text: 'On v1', t: 4_000_000 });
    // As in a browser: a new source has no frames until its metadata has loaded.
    let ready = 4;
    Object.defineProperty(page.video, 'readyState', { configurable: true, get: () => ready });
    const src = page.video.getAttribute('src');
    page.video._time = 0;
    ready = 0;
    page.seekToComment(page.session.comments.get(c.id));
    await until(() => page.version === 1 && page.video.getAttribute('src') !== src);
    await until(() => page.t === 4_000_000);
    expect(page.video.currentTime).toBe(0);
    ready = 1;
    page.video.dispatchEvent(new Event('loadedmetadata'));
    expect(page.video.currentTime).toBeCloseTo(4.02, 5);
    expect(page.t).toBe(4_000_000);
    page.dispose();
  });

  it('shows why a link does not work', async () => {
    const env = await setup();
    const pub = await publish(env);
    const root = document.createElement('div');
    document.body.append(root);
    const page = new ReviewPage(root, { puter: env.sdk.dave, link: { review: pub.review.id, server: env.server, token: 'B'.repeat(43) } });
    await until(() => root.querySelector('.splash-title'));
    expect(root.querySelector('.splash-title').textContent).toBe('This review is not available');
    expect(root.textContent).toMatch(/not valid/);
    page.dispose();
  });

  it('asks people to sign in first', async () => {
    const env = await setup();
    const root = document.createElement('div');
    const puter = env.world.sdk(USERS.carol, { signedIn: false });
    const onSignedIn = vi.fn();
    const page = new ReviewPage(root, { puter, link: { review: 'r_abcdefgh', server: env.server, token: null }, onSignedIn });
    expect(root.textContent).toMatch(/Sign in with Puter to watch it/);
    btn(root, 'Sign in with Puter').click();
    await until(() => onSignedIn.mock.calls.length);
    page.dispose();
  });
});

describe('editor review panel', () => {
  it('lists comments, seeks through the version range, resolves and adds markers', async () => {
    const env = await setup();
    const p = projectWithClips();
    p.id = 'proj_000001';
    const store = new EditorStore(p);
    const ctx = { store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {}, openShareReview: vi.fn() };
    const panel = createReviewPanel(ctx, { deps: { interval: 60_000 } });
    document.body.append(panel.el);
    panel.toggle(true);
    // Not shared yet.
    const share = await until(() => btn(panel.el, 'Share for review...'));
    share.click();
    expect(ctx.openShareReview).toHaveBeenCalled();
    // Shared from the in/out range 4 s to 9 s; bob comments at 1 s into the review.
    const pub = await publish(env, { projectId: 'proj_000001', duration: 5_000_000, range: { in: 4_000_000, out: 9_000_000 } });
    await env.as('bob')('join', { review: pub.review.id, token: await invite(env, pub.review.id) });
    await env.as('bob')('comment.add', { review: pub.review.id, version: 1, id: 'c_panel001', text: 'Hold this shot longer', t: 1_000_000 });
    await panel.refresh();
    await until(() => panel.el.querySelector('.rv-thread'));
    expect(panel.el.querySelector('.rv-author').textContent).toBe('bob');
    expect(panel.el.querySelector('.rv-panel-counts').textContent).toBe('1 open');
    panel.el.querySelector('.rv-time').click();
    expect(store.time).toBe(5_000_000);
    btn(panel.el, 'Add as markers').click();
    expect(store.project.markers).toEqual([expect.objectContaining({ time: 5_000_000, label: 'bob: Hold this shot longer', note: 'Hold this shot longer' })]);
    btn(panel.el, 'Add as markers').click();
    expect(store.project.markers.length).toBe(1);
    store.undo();
    expect(store.project.markers.length).toBe(0);
    btn(panel.el, 'Resolve').click();
    await until(() => panel.el.querySelector('.rv-thread.resolved'));
    expect((await env.as('bob')('sync', { review: pub.review.id, since: 1 })).changes[0].resolved).toBe(true);
    // Polling stops when the panel closes.
    expect(panel.session.polling).toBe(true);
    panel.toggle(false);
    expect(panel.session.polling).toBe(false);
    panel.dispose();
  });

  it('opens the timeline a version was shared from before seeking or adding markers', async () => {
    const env = await setup();
    const store = new EditorStore(projectWithClips());
    const deps = { exportProject: fakeExport(), detectCapabilities: caps };
    let short;
    store.update('New timeline', (p) => {
      short = addTimeline(p, { name: 'Short' });
    });
    const main = store.project.timelineId;
    const v1 = await shareForReview({ puter: env.sdk.alice, project: store.project, library: null, title: 'Main', deps });
    store.openTimeline(short);
    store.update('clip', (p) => onMain(p, clip('video', 0, 6)));
    store.update('range', (p) => (p.range = { in: s(2), out: s(5) }));
    const v2 = await shareForReview({ puter: env.sdk.alice, project: store.project, library: null, scope: 'range', title: 'Short', deps });
    expect(v2.review.id).toBe(v1.review.id);
    expect(v2.review.versions.map((v) => v.timelineId)).toEqual([main, short]);
    // Reviewers never see it.
    await env.as('bob')('join', { review: v1.review.id, token: await invite(env, v1.review.id) });
    expect((await env.as('bob')('review.get', { review: v1.review.id })).review.versions.some((v) => 'timelineId' in v)).toBe(false);
    await env.as('bob')('comment.add', { review: v1.review.id, version: 2, id: 'c_short001', text: 'Tighter', t: s(1) });

    store.openTimeline(main);
    const panel = createReviewPanel({ store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {} }, { deps: { interval: 60_000 } });
    document.body.append(panel.el);
    panel.toggle(true);
    await until(() => panel.el.querySelector('.rv-thread'));
    panel.el.querySelector('.rv-time').click();
    expect([store.project.timelineId, store.time]).toEqual([short, s(3)]);
    store.openTimeline(main);
    btn(panel.el, 'Add as markers').click();
    expect(store.project.timelineId).toBe(short);
    expect(store.project.markers.map((m) => m.time)).toEqual([s(3)]);
    store.openTimeline(main);
    expect(store.project.markers || []).toEqual([]);
    panel.dispose();
  });

  it('leaves a compound clip being edited before seeking or adding markers', async () => {
    const env = await setup();
    const p = projectWithClips();
    onMain(p, clip('video', 10, 4));
    const store = new EditorStore(p);
    const deps = { exportProject: fakeExport(), detectCapabilities: caps };
    const v1 = await shareForReview({ puter: env.sdk.alice, project: store.project, library: null, title: 'Main', deps });
    await env.as('alice')('comment.add', { review: v1.review.id, version: 1, id: 'c_comp0001', text: 'Here', t: s(12) });
    const second = mainTrackOf(store.project).clips[1].id;
    store.update('Group', (pp) => createCompound(pp, [second]));
    const comp = mainTrackOf(store.project).clips[1].id;
    const panel = createReviewPanel({ store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {} }, { deps: { interval: 60_000 } });
    document.body.append(panel.el);
    panel.toggle(true);
    await until(() => panel.el.querySelector('.rv-thread'));
    store.openCompound(comp);
    panel.el.querySelector('.rv-time').click();
    // The comment's time is on the timeline, not inside the compound clip.
    expect(store.nest).toHaveLength(0);
    expect(store.time).toBe(s(12));
    store.openCompound(comp);
    btn(panel.el, 'Add as markers').click();
    expect(store.nest).toHaveLength(0);
    expect(store.project.markers.map((m) => m.time)).toEqual([s(12)]);
    panel.dispose();
  });

  it('turns threads into markers once', () => {
    const v = { duration: 5_000_000, range: { in: 1_000_000, out: 6_000_000 } };
    const t = (id, f = {}) => ({ id, t: 0, text: id, author: { username: 'bob' }, ...f });
    const m = reviewMarkers([t('a'), t('b', { t: 2_000_000, resolved: true }), t('c', { deleted: true }), t('d', { t: null })], v, [{ time: 1_000_000, note: 'a' }]);
    expect(m.map((x) => [x.time, x.label])).toEqual([[3_000_000, 'bob: b']]);
  });
});

describe('review accessibility', () => {
  it('review page, share dialog and panel have no serious problems', async () => {
    const env = await setup();
    const pub = await publish(env, { projectId: 'proj_000001' });
    const token = await invite(env, pub.review.id);
    await env.as('bob')('join', { review: pub.review.id, token });
    await env.as('bob')('comment.add', { review: pub.review.id, version: 1, id: 'c_a11y0001', text: 'Check this', t: 1_000_000, end: 2_000_000 });
    await env.as('alice')('comment.add', { review: pub.review.id, version: 1, id: 'c_a11y0002', parent: 'c_a11y0001', text: 'Done' });
    const root = document.createElement('div');
    document.body.append(root);
    const page = new ReviewPage(root, { puter: env.sdk.bob, link: { review: pub.review.id, server: env.server, token: null }, interval: 60_000 });
    await until(() => root.querySelector('.rv-thread'));
    expect(await violations(root)).toEqual([]);
    page.dispose();
    root.remove();

    const p = projectWithClips();
    p.id = 'proj_000001';
    const store = new EditorStore(p);
    const ctx = { store, library: { backend: { kind: 'puter' } }, puter: env.sdk.alice, account: {}, review: { refresh() {}, toggle() {} } };
    const dlg = openShareDialog(ctx);
    await until(() => dlg.el.querySelector('[aria-label=People] .rv-row:not(.empty)'));
    expect(await violations(dlg.el)).toEqual([]);
    dlg.close();

    const panel = createReviewPanel({ ...ctx, review: undefined }, { deps: { interval: 60_000 } });
    document.body.append(panel.el);
    panel.toggle(true);
    await until(() => panel.el.querySelector('.rv-reply'));
    expect(await violations(panel.el)).toEqual([]);
    panel.dispose();
  });
});
