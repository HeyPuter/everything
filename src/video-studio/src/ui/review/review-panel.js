/**
 * Review panel in the editor: the comments on this project's review, per
 * version, kept current while the panel is open (polling, plus Refresh).
 * Clicking a comment's time moves the playhead there, through the range the
 * version was rendered from, on the timeline it was shared from (opened
 * first when another one is open). Comments can also be added as timeline
 * markers there.
 */
import '../../styles/review.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { uid } from '../../lib/ids.js';
import { MARKER_COLORS } from '../../model/project.js';
import { activeTimeline } from '../../model/timelines.js';
import { ensureWorker as ensureWorkerDefault, call as callDefault } from '../../review/api.js';
import { ReviewSession } from '../../review/session.js';
import { threadsFor, threadCounts } from '../../review/comments.js';
import { toEditorTime, reviewFps } from '../../review/time.js';
import { createThreadList } from './threads.js';
import { reviewAvailable } from './share-dialog.js';
import { confirmDialog, toast } from '../dialog.js';

/** How often the panel checks for new comments while open (ms). */
export const PANEL_POLL_MS = 15_000;

/** Markers for threads not already on the timeline (same time and note). */
export function reviewMarkers(threads, version, existing = []) {
  const out = [];
  for (const t of threads) {
    if (t.deleted || t.t === null) continue;
    const time = toEditorTime(t.t, version);
    const label = `${t.author?.username || 'Review'}: ${t.text}`.replace(/\s+/g, ' ').slice(0, 200);
    if (existing.some((m) => m.time === time && m.note === t.text) || out.some((m) => m.time === time && m.note === t.text)) continue;
    out.push({ id: uid('m'), time, color: t.resolved ? MARKER_COLORS[2] : MARKER_COLORS[0], label, note: t.text.slice(0, 2000) });
  }
  return out;
}

export function createReviewPanel(ctx, { deps = {} } = {}) {
  const d = { ensureWorker: ensureWorkerDefault, call: callDefault, Session: ReviewSession, interval: PANEL_POLL_MS, ...deps };
  const P = () => ctx.puter || globalThis.puter;
  const { store } = ctx;
  let session = null;
  let version = 0;
  let followLatest = true;
  let showResolved = true;
  let opening = null;
  let offs = [];

  const versionSelect = h('select.select.small.rv-panel-version', { 'aria-label': 'Version' });
  const refreshBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Check for new comments', 'data-tip': 'Refresh' }, icon('refresh', 14));
  const close = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Close review comments', 'data-tip': 'Close' }, icon('close', 14));
  const resolvedId = `rvp-resolved-${Math.random().toString(36).slice(2, 7)}`;
  const resolvedBox = h('input', { type: 'checkbox', id: resolvedId, checked: true });
  const markersBtn = h('button.rv-action', { type: 'button' }, icon('bookmark', 14), 'Add as markers');
  const status = h('p.rv-sync', { role: 'status' });
  const counts = h('span.rv-panel-counts');
  /** Open the timeline version v was shared from, when it still exists and another is open. Returns its name or null. */
  function openVersionTimeline(v) {
    const id = v?.timelineId;
    if (!id || id === store.project.timelineId || !store.project.timelines?.some((t) => t.id === id)) return null;
    return store.openTimeline(id) ? activeTimeline(store.project).name : null;
  }

  const list = createThreadList({
    onSeek: (t) => {
      const v = session.version(t.version);
      const opened = openVersionTimeline(v);
      store.seek(toEditorTime(t.t, v));
      announce(opened ? `Opened ${opened} and moved the playhead to the comment` : 'Playhead moved to the comment');
    },
    onReply: (t, text) => session.addComment({ version: t.version, parent: t.id, text }),
    onResolve: (t, resolved) => session.resolve(t.id, resolved).catch((err) => toast(err.message, { kind: 'error' })),
    onEdit: (c, text) => session.editComment(c.id, text),
    onDelete: async (c) => {
      if (!(await confirmDialog({ title: 'Delete comment', message: 'Delete this comment for everyone? This cannot be undone.', confirm: 'Delete', danger: true }))) return;
      session.deleteComment(c.id).catch((err) => toast(err.message, { kind: 'error' }));
    },
  });
  const tools = h('div.rv-panel-tools', h('label.rv-toggle', { for: resolvedId }, resolvedBox, 'Show resolved'), markersBtn);
  const content = h('div.rv-panel-body');
  const el = h('aside.review-panel', { hidden: true, 'aria-label': 'Review comments' },
    h('div.history-head', icon('comment', 14), h('span', 'Review'), counts, h('span.spacer'), versionSelect, refreshBtn, close),
    content);

  close.addEventListener('click', () => toggle(false));
  refreshBtn.addEventListener('click', () => refresh(true));
  resolvedBox.addEventListener('change', () => {
    showResolved = resolvedBox.checked;
    render();
  });
  versionSelect.addEventListener('change', () => {
    version = Number(versionSelect.value);
    followLatest = version === session?.latest;
    render();
  });
  markersBtn.addEventListener('click', () => {
    const v = session?.version(version);
    if (!v) return;
    openVersionTimeline(v);
    const add = reviewMarkers(threadsFor(session.comments, version, { showResolved }), v, store.project.markers || []);
    if (!add.length) {
      toast('These comments are already markers.', { kind: 'info' });
      return;
    }
    store.update('Add review comments as markers', (p) => {
      p.markers = [...(p.markers || []), ...add].sort((a, b) => a.time - b.time);
    }, { structural: false });
    toast(`Added ${add.length} marker${add.length === 1 ? '' : 's'}.`, { kind: 'success' });
  });

  function message(text, action) {
    content.replaceChildren(h('div.rv-panel-empty', h('p', text), action));
  }

  function renderVersions() {
    if (!session?.review) return;
    const vs = [...session.review.versions].reverse();
    versionSelect.replaceChildren(...vs.map((v) => h('option', { value: String(v.n) }, `Version ${v.n}${v.n === session.latest ? ' (latest)' : ''}`)));
    if (followLatest || !session.version(version)) version = session.latest;
    versionSelect.value = String(version);
    versionSelect.hidden = vs.length < 2;
  }

  function render() {
    if (el.hidden || !session?.review) return;
    const v = session.version(version);
    const threads = threadsFor(session.comments, version, { showResolved });
    const c = threadCounts(session.comments, version);
    counts.textContent = c.open ? `${c.open} open` : '';
    list.update(threads, { fps: reviewFps(v?.fps), me: session.me, role: session.role, empty: 'No comments on this version yet.' });
    markersBtn.disabled = !threads.some((t) => !t.deleted);
    if (!content.contains(list.el)) content.replaceChildren(tools, list.el, status);
  }

  async function open() {
    if (!reviewAvailable(ctx)) {
      const signIn = ctx.account?.onSignIn ? h('button.btn.small', { type: 'button' }, 'Sign in to Puter') : null;
      signIn?.addEventListener('click', () => ctx.account.onSignIn());
      message('Review comments need a Puter account.', signIn);
      return;
    }
    message('Loading review comments...');
    const puter = P();
    const server = await d.ensureWorker(puter);
    const found = await d.call(puter, server, { op: 'review.find', projectId: store.project.id });
    if (!found.review) {
      const share = h('button.btn.small.primary', { type: 'button' }, icon('shareReview', 14), 'Share for review...');
      share.addEventListener('click', () => ctx.openShareReview?.());
      message('This project has not been shared for review yet. Share it to collect comments here.', share);
      return;
    }
    session?.dispose();
    for (const off of offs.splice(0)) off();
    session = new d.Session({ puter, server, review: found.review.id, call: d.call, interval: d.interval });
    offs.push(session.on('change', render));
    offs.push(session.on('review', () => {
      renderVersions();
      render();
    }));
    offs.push(session.on('synced', () => (status.textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)));
    offs.push(session.on('error', () => (status.textContent = 'Could not check for new comments. Retrying...')));
    await session.open();
    renderVersions();
    render();
  }

  /** Re-check comments now; reopen when the project has no session yet (as after a first share). */
  async function refresh(manual = false) {
    if (el.hidden) return;
    try {
      if (!session) {
        opening = opening || open().finally(() => (opening = null));
        await opening;
      } else {
        await session.refreshReview();
        await session.sync();
      }
      if (session && !el.hidden && !session.polling) session.start(d.interval);
      if (manual) announce('Comments checked');
    } catch (err) {
      if (!session) message(err?.message || 'Could not load review comments.', null);
      else status.textContent = err?.message || 'Could not check for new comments.';
    }
  }

  function toggle(on = el.hidden) {
    el.hidden = !on;
    if (on) refresh();
    else session?.stop();
  }

  function dispose() {
    for (const off of offs.splice(0)) off();
    session?.dispose();
  }

  return {
    el,
    toggle,
    refresh,
    dispose,
    get session() {
      return session;
    },
    get open() {
      return !el.hidden;
    },
  };
}
