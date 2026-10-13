// A shared document in the editor: its tab's history becomes a SharedHistory
// bound to the room, other people's cursors, active layers, selections and
// tools are drawn over the canvas, a status chip and avatars sit in the top
// bar with a participants popover (follow someone's view from there), and
// the document leaves the room when its tab closes.
import './collab.css';
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { layerBounds } from '../../model/artboard';
import { History } from '../../history/history';
import { centerPoint, panToCenter } from '../../app/view-transform';
import { MemoryStore, IndexedDbStore } from '../../persistence/local-store';
import { formDialog } from '../../ui/dialog';
import { call } from '../../collab/api';
import { RoomClient, type Outbox, type OutboxStores, type Person, type Presence } from '../../collab/client';
import { openBinding, type SharedBinding } from '../../collab/shared-history';
import { SharedComments } from '../../collab/shared-comments';
import { TileIndex } from '../../collab/tile-index';
import { colorFor, initials, roleLabel, shareLink, type RoomLink } from '../../collab/protocol';
import { collabPuter } from '../../collab/puter-types';
import { adoptLocalComments, dropLocalComments, shared, sharedOf, type SharedHandle } from './state';

let outbox: Outbox | undefined;
/** Browser storage for undelivered changes (memory when IndexedDB is unavailable). */
export function outboxStore(): Outbox {
  if (!outbox) {
    try {
      outbox = typeof indexedDB === 'undefined' ? new MemoryStore<OutboxStores>() : new IndexedDbStore<OutboxStores>('photo-studio-collab', ['outbox', 'blobs']);
    } catch {
      outbox = new MemoryStore<OutboxStores>();
    }
  }
  return outbox;
}

export type Member = { uuid: string; username: string; role: string };

export class CollabSession implements SharedHandle {
  comments: SharedComments;
  members: Member[] = [];
  following = '';
  private cursor: [number, number] | null = null;
  private applied?: { zoom: number; x: number; y: number };
  private membersAt = 0;
  constructor(
    public e: Editor,
    public s: DocumentSession,
    public client: RoomClient,
    public binding: SharedBinding,
    public link: RoomLink,
    public review: boolean,
  ) {
    this.comments = new SharedComments(client, () => {
      if (e.session === s) {
        e.overlay();
        e.dock?.update();
      }
    });
  }
  get role() {
    return this.client.role;
  }
  people() {
    const names = new Set(this.members.map((m) => m.username));
    for (const p of this.client.people.values()) names.add(p.username);
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  /** The link that reopens this document for its members (no invitation). */
  memberLink() {
    return shareLink(location.href, { server: this.link.server, room: this.link.room, review: this.review });
  }
  async loadMembers(force = false) {
    if (!force && Date.now() - this.membersAt < 10_000) return;
    this.membersAt = Date.now();
    try {
      const res = await call<{ members: Member[] }>(this.client.o.puter, this.link.server, { op: 'members', room: this.link.room });
      this.members = res.members;
      renderBar(this.e);
    } catch {
      /* The list is a convenience (mentions, the popover). */
    }
  }

  // ----- Presence -----

  private presence(): Presence {
    const e = this.e;
    if (e.session !== this.s) return { cursor: null };
    const [x, y] = centerPoint(e.activeView.state(e.viewAspect()), e.doc);
    const l = e.layer;
    return {
      cursor: this.cursor,
      tool: e.tool,
      toolLabel: e.activeTool?.label,
      layer: e.selected || undefined,
      layerBounds: l ? (layerBounds(l) ?? null) : null,
      selection: e.doc.selection ?? null,
      view: { x, y, zoom: e.zoom },
    };
  }
  pointer(x: number | undefined, y: number | undefined) {
    this.cursor = x === undefined || y === undefined ? null : [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    this.client.setPresence(this.presence());
  }
  changed() {
    this.client.setPresence(this.presence());
    if (this.following && !this.applying) {
      const e = this.e;
      const a = this.applied;
      // The person moved the view themselves: stop following.
      if (e.session === this.s && a && (Math.abs(e.zoom - a.zoom) > 1e-6 || Math.abs(e.pan.x - a.x) > 0.5 || Math.abs(e.pan.y - a.y) > 0.5)) {
        const who = this.client.people.get(this.following)?.username;
        this.following = '';
        this.applied = undefined;
        e.message(who ? `Stopped following ${who}.` : 'Stopped following.');
        renderBar(e);
      }
    }
  }
  private applying = false;
  /** Adopt the followed person's view. */
  followView() {
    const p = this.client.people.get(this.following);
    const e = this.e;
    if (!p?.view || e.session !== this.s) return;
    this.applying = true;
    try {
      e.zoom = p.view.zoom;
      e.pan = panToCenter(e.activeView.state(e.viewAspect()), e.doc, p.view.x, p.view.y);
      this.applied = { zoom: e.zoom, x: e.pan.x, y: e.pan.y };
      e.view();
      e.overlay();
      e.windows.renderTabs();
    } finally {
      this.applying = false;
    }
  }
  follow(session: string) {
    const p = this.client.people.get(session);
    if (!p) return;
    this.following = session;
    this.followView();
    this.e.message(`Following ${p.username}. Move the view to stop.`);
    renderBar(this.e);
  }
  peopleChanged() {
    if (this.following && !this.client.people.has(this.following)) {
      this.following = '';
      this.e.message('The person you followed left.');
    }
    if (this.following) this.followView();
    if (this.e.session === this.s) this.e.overlay();
    renderBar(this.e);
    void this.loadMembers();
  }
  /** Other people's cursors, active layers and selections (document markup). */
  overlay(e: Editor) {
    const k = 1 / e.zoom;
    let out = '';
    for (const p of this.client.people.values()) {
      if (p.user === this.client.user?.uuid && p.session === this.client.session) continue;
      const color = colorFor(p.user);
      const rect = (r: Person['selection'], dash: string) =>
        r ? `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="${color}" stroke-width="${1.5 * k}" stroke-dasharray="${dash}" vector-effect="none"/>` : '';
      out += rect(p.layerBounds, `${6 * k} ${3 * k}`);
      out += rect(p.selection, `${2 * k} ${2 * k}`);
      if (p.cursor) {
        const [x, y] = p.cursor;
        const label = `${p.username}${p.toolLabel ? ` · ${p.toolLabel.replace(/ Tool$/, '')}` : ''}`;
        const w = (label.length * 6.4 + 12) * k;
        out += `<g class="collab-cursor"><path d="M${x} ${y}l${11 * k} ${11 * k}h${-6 * k}l${-5 * k} ${5 * k}Z" fill="${color}" stroke="#fff" stroke-width="${1 * k}" stroke-linejoin="round"/><rect x="${x + 10 * k}" y="${y + 14 * k}" width="${w}" height="${16 * k}" rx="${3 * k}" fill="${color}"/><text x="${x + 16 * k}" y="${y + 22 * k}" fill="#fff" font-size="${11 * k}" dominant-baseline="central" font-family="system-ui, sans-serif">${escapeXML(label)}</text></g>`;
      }
    }
    return out;
  }

  // ----- Lifecycle -----

  busy() {
    const e = this.e;
    return e.toolBusy || e.transform.active || e.transform.dragging || !!e.modal || !!document.querySelector('dialog[open]');
  }
  documentChanged() {
    const e = this.e;
    this.s.saved = this.s.doc;
    if (e.session === this.s) e.update();
    else e.windows.renderTabs();
  }
  statusChanged() {
    const st = this.client.status;
    if (st.state === 'error') {
      this.toLocal(`${st.message ?? 'Sharing ended.'} This tab keeps a copy; save it to keep your work.`);
      return;
    }
    renderBar(this.e);
  }
  /** Leave the room and keep working on a local copy. */
  toLocal(message?: string) {
    const { e, s } = this;
    if (shared.get(s) !== this) return;
    const doc = s.doc;
    const h = new History(doc);
    h.limit = s.history.limit;
    h.nonLinear = s.history.nonLinear;
    h.normalize = s.history.normalize;
    s.history = h;
    adoptLocalComments(e, s, this.comments.threads().filter((t) => !t.deleted));
    shared.delete(s);
    s.closeHandler = undefined;
    s.saved = undefined;
    this.binding.close();
    void this.client.leave();
    if (message) e.message(message);
    if (e.session === s) e.update();
    renderBar(e);
  }
  async closeTab() {
    const pending = this.client.status.pending;
    if (pending && !(await formDialog(`Close “${this.s.doc.name}”?`, [], 'Close', `${pending} change${pending === 1 ? ' has' : 's have'} not reached the shared document yet. They stay in this browser and are sent the next time you open it here.`)))
      return false;
    shared.delete(this.s);
    this.binding.close();
    await this.client.leave();
    renderBar(this.e);
    return true;
  }
  refused(message: string) {
    // The worker refused a change for good (for example after a role change):
    // open the shared state again in this tab.
    this.e.message(`A change was not accepted: ${message} The shared document was reloaded.`);
    void this.reopen();
  }
  async reopen() {
    const { e, s } = this;
    if (shared.get(s) !== this) return;
    shared.delete(s);
    this.binding.close();
    this.client.close();
    try {
      await openShared(e, this.link, { target: s, review: this.review });
    } catch (error) {
      e.message(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Join a room and show its document (in a new tab, or in `target`). */
export async function openShared(e: Editor, link: RoomLink, o: { target?: DocumentSession; review?: boolean; client?: RoomClient } = {}) {
  const puter = collabPuter();
  if (!puter.auth.isSignedIn()) await puter.auth.signIn();
  const target = o.target;
  const assets = target?.assets;
  let session: DocumentSession | undefined = target;
  let client = o.client;
  let cs: CollabSession | undefined;
  if (!client) {
    const a = assets ?? new (await import('../../model/assets')).Assets();
    client = new RoomClient({ puter, server: link.server, room: link.room, token: link.token, tiles: new TileIndex(a.tiles), assets: a, store: outboxStore() });
    e.message('Joining the shared document…');
    await client.join();
  }
  const c = client;
  const binding = await openBinding(c, c.o.assets, {
    busy: () => cs?.busy() ?? true,
    onDocument: () => cs?.documentChanged(),
    onMessage: (text) => e.message(text),
  }, (text) => e.message(text));
  if (!session) {
    session = e.sessionForOpen();
    session.assets.clear();
    session.assets = c.o.assets;
  }
  const s = session;
  cs = new CollabSession(e, s, c, binding, { server: link.server, room: link.room }, !!o.review || (c.role !== 'owner' && c.role !== 'editor' && !!link.review));
  c.o.onStatus = () => cs!.statusChanged();
  c.o.onPeople = () => cs!.peopleChanged();
  c.o.onRefused = (m) => cs!.refused(m);
  const h = binding.history,
    old = s.history;
  h.limit = old.limit;
  h.nonLinear = old.nonLinear;
  h.normalize = old.normalize;
  s.history = h;
  s.hasDocument = true;
  s.saved = h.document;
  s.unsavedExtras = false;
  dropLocalComments(s);
  shared.set(s, cs);
  s.closeHandler = () => cs!.closeTab();
  install(e);
  if (e.session !== s) await e.switchSession(s);
  if (cs.review) enterReview(e, cs);
  e.fit();
  e.update();
  void cs.loadMembers(true);
  renderBar(e);
  e.message(`Opened the shared document “${c.name || 'Untitled'}” (${roleLabel(c.role).toLowerCase()}).`);
  return cs;
}

// ----- Workspace integration (installed once) -----

let installed = false;
const active = (e: Editor) => {
  const sh = sharedOf(e.session);
  return sh instanceof CollabSession ? sh : undefined;
};
function install(e: Editor) {
  if (installed) return;
  installed = true;
  e.pointerHooks.push((ed, p) => active(ed)?.pointer(p?.x, p?.y));
  e.viewHooks.push((ed) => active(ed)?.changed());
  e.onUpdate((ed) => {
    const cs = active(ed);
    cs?.changed();
    renderBar(ed);
    document.documentElement.classList.toggle('review-mode', !!cs?.review);
    // A layer comp shown in the review view stays shown as the document updates.
    if (cs?.review && reviewComp) queueMicrotask(() => void showComp(ed, reviewComp));
  });
  e.el('#viewport').addEventListener('pointerleave', () => active(e)?.pointer(undefined, undefined));
  const all = () => [...shared.values()].filter((x): x is CollabSession => x instanceof CollabSession);
  window.addEventListener('online', () => {
    for (const cs of all()) {
      cs.client.flush();
      cs.client.scheduleSync(0);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') for (const cs of all()) cs.client.scheduleSync(0);
  });
  window.addEventListener('pagehide', () => {
    for (const cs of all()) void cs.client.leave();
  });
  document.addEventListener('keydown', (ev) => {
    const pop = document.querySelector<HTMLElement>('.collab-popover');
    if (ev.key !== 'Escape' || !pop || pop.hidden) return;
    const inside = pop.contains(document.activeElement);
    closePopover();
    // Keyboard users return to the button that opened it.
    if (inside) document.querySelector<HTMLElement>('.collab-bar .collab-people')?.focus();
  });
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest('.collab-popover,.collab-bar')) closePopover();
  });
}

// ----- Top bar: status chip, avatars, participants popover -----

function bar(e: Editor) {
  let el = e.root.querySelector<HTMLElement>('.collab-bar');
  if (!el) {
    el = document.createElement('div');
    el.className = 'collab-bar';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Shared document');
    e.el('.top-actions').prepend(el);
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('[data-collab-people]')) togglePopover(e);
    });
  }
  return el;
}
function statusText(cs: CollabSession) {
  const st = cs.client.status;
  if (st.state === 'offline') return { cls: 'warn', icon: 'cloud', text: `Offline · ${st.pending} pending`, long: `Offline. ${st.pending} change${st.pending === 1 ? ' is' : 's are'} kept in this browser and sent when the connection returns.` };
  if (st.state === 'syncing') return { cls: '', icon: 'refresh-cw', text: 'Syncing…', long: `Sending ${st.pending} change${st.pending === 1 ? '' : 's'}…` };
  if (st.state === 'connecting') return { cls: '', icon: 'refresh-cw', text: 'Connecting…', long: 'Connecting to the shared document…' };
  if (st.state === 'error' || st.state === 'closed') return { cls: 'error', icon: 'ban', text: 'Disconnected', long: st.message ?? 'Disconnected.' };
  return { cls: 'ok', icon: 'check', text: 'Connected', long: 'Connected. All changes are saved to the shared document.' };
}
function present(cs: CollabSession) {
  // One avatar per person (several tabs count once), this person first.
  const out = new Map<string, { user: string; username: string; role: string; sessions: Person[] }>();
  const me = cs.client.user;
  if (me) out.set(me.uuid, { user: me.uuid, username: me.username, role: cs.client.role, sessions: [] });
  for (const p of cs.client.people.values()) {
    const entry = out.get(p.user) ?? { user: p.user, username: p.username, role: p.role, sessions: [] };
    entry.sessions.push(p);
    out.set(p.user, entry);
  }
  return [...out.values()];
}
export function renderBar(e: Editor) {
  const cs = active(e);
  const el = bar(e);
  if (!cs) {
    el.hidden = true;
    el.innerHTML = '';
    closePopover();
    return;
  }
  el.hidden = false;
  const st = statusText(cs);
  const people = present(cs);
  const avatars = people
    .slice(0, 4)
    .map((p) => `<span class="collab-avatar${cs.following && p.sessions.some((x) => x.session === cs.following) ? ' following' : ''}" style="--person:${colorFor(p.user)}" title="${escapeXML(p.username)}${p.user === cs.client.user?.uuid ? ' (you)' : ''} · ${escapeXML(roleLabel(p.role))}">${escapeXML(initials(p.username))}</span>`)
    .join('');
  const more = people.length > 4 ? `<span class="collab-avatar more">+${people.length - 4}</span>` : '';
  const html = `<button class="collab-status ${st.cls}" data-collab-people aria-haspopup="dialog" title="${escapeXML(st.long)}">${svg(st.icon, 14)}<span>${escapeXML(st.text)}</span>${cs.role === 'owner' || cs.role === 'editor' ? '' : `<span class="collab-role">${cs.role === 'commenter' ? 'Comment only' : 'View only'}</span>`}</button><button class="collab-people" data-collab-people aria-haspopup="dialog" aria-label="People in this document (${people.length})" title="People">${avatars}${more}</button>`;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
  const pop = document.querySelector<HTMLElement>('.collab-popover');
  if (pop && !pop.hidden) fillPopover(cs, pop);
  syncExpanded();
}
/** aria-expanded of the buttons that open the people popover. */
function syncExpanded() {
  const open = !!document.querySelector('.collab-popover:not([hidden])');
  for (const b of document.querySelectorAll('.collab-bar [data-collab-people]')) b.setAttribute('aria-expanded', String(open));
}
function closePopover() {
  const pop = document.querySelector<HTMLElement>('.collab-popover');
  if (pop) pop.hidden = true;
  syncExpanded();
}
function togglePopover(e: Editor) {
  const cs = active(e);
  let pop = document.querySelector<HTMLElement>('.collab-popover');
  if (pop && !pop.hidden) return closePopover();
  if (!cs) return;
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'collab-popover popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'People in this document');
    document.body.append(pop);
    pop.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const c = active(e);
      const follow = t.closest<HTMLElement>('[data-follow]')?.dataset.follow;
      if (follow !== undefined && c) {
        if (follow === c.following) {
          c.following = '';
          e.message('Stopped following.');
          renderBar(e);
        } else c.follow(follow);
        return;
      }
      if (t.closest('[data-copy-link]') && c) {
        void navigator.clipboard?.writeText(c.memberLink()).then(
          () => e.message('Link copied. It opens the document for its members.'),
          () => e.message(c.memberLink()),
        );
        return;
      }
      const cmd = t.closest<HTMLElement>('[data-popover-command]')?.dataset.popoverCommand;
      if (cmd) {
        closePopover();
        void e.runCommand(cmd);
      }
    });
  }
  pop.hidden = false;
  void cs.loadMembers(true);
  fillPopover(cs, pop);
  const r = e.root.querySelector('.collab-bar')!.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, r.right - 300))}px`;
  syncExpanded();
  pop.querySelector<HTMLElement>('button')?.focus();
}
function fillPopover(cs: CollabSession, pop: HTMLElement) {
  const st = statusText(cs);
  const here = present(cs);
  const ids = new Set(here.map((p) => p.user));
  const away = cs.members.filter((m) => !ids.has(m.uuid));
  const row = (user: string, name: string, role: string, extra: string, actions = '') =>
    `<li class="collab-person"><span class="collab-avatar" style="--person:${colorFor(user)}">${escapeXML(initials(name))}</span><span class="collab-person-text"><span>${escapeXML(name)}${user === cs.client.user?.uuid ? ' <span class="muted">(you)</span>' : ''}</span><span class="muted">${escapeXML(roleLabel(role))}${extra ? ` · ${escapeXML(extra)}` : ''}</span></span>${actions}</li>`;
  const rows = here
    .map((p) => {
      const s = p.sessions[0];
      const following = s && cs.following === s.session;
      const follow = s?.view ? `<button class="icon-button" data-follow="${s.session}" aria-pressed="${following}" title="${following ? 'Stop following' : `Follow ${escapeXML(p.username)}'s view`}" aria-label="${following ? 'Stop following' : `Follow ${escapeXML(p.username)}`}">${svg('follow-view', 15)}</button>` : '';
      return row(p.user, p.username, p.role, s ? (s.toolLabel ?? 'here') : p.user === cs.client.user?.uuid ? 'here' : '', p.user === cs.client.user?.uuid ? '' : follow);
    })
    .concat(away.map((m) => row(m.uuid, m.username, m.role, 'not here')))
    .join('');
  const owner = cs.role === 'owner';
  const actions = `<div class="collab-popover-actions">${owner ? `<button data-popover-command="file.invite-to-edit">${svg('invite-edit', 14)}Invite to Edit…</button><button data-popover-command="file.share-for-review">${svg('share-review', 14)}Share for Review…</button>` : ''}<button data-copy-link>${svg('link', 14)}Copy Link</button>${owner ? `<button data-popover-command="file.stop-sharing">${svg('unlink', 14)}Stop Sharing…</button>` : ''}</div>`;
  const html = `<div class="collab-popover-status ${st.cls}">${svg(st.icon, 14)}<span>${escapeXML(st.long)}</span></div><ul class="collab-people-list">${rows}</ul>${actions}`;
  if (pop.dataset.html !== html) {
    pop.dataset.html = html;
    pop.innerHTML = html;
  }
}

// ----- Review view -----

function enterReview(e: Editor, cs: CollabSession) {
  document.documentElement.classList.add('review-mode');
  e.setTool(cs.client.canComment ? 'comment' : 'hand');
  if (!e.dock.isVisible('comments')) e.dock.show('comments');
  reviewHeader(e, cs);
}
/** The review header: what is open, artboards and layer comps to look at. */
function reviewHeader(e: Editor, cs: CollabSession) {
  let el = e.root.querySelector<HTMLElement>('.review-header');
  if (!el) {
    el = document.createElement('div');
    el.className = 'review-header';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Review');
    e.el('.optionsbar').after(el);
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLSelectElement;
      const doc = e.doc;
      if (t.dataset.review === 'artboard') {
        const a = doc.layers.find((l) => l.id === t.value);
        const r = a?.artboard?.rect;
        if (r) {
          const vp = e.viewportSize();
          e.zoomBy(Math.min((vp.width * 0.9) / r.width, (vp.height * 0.9) / r.height), undefined, undefined, [r.x + r.width / 2, r.y + r.height / 2]);
        } else e.fit();
      }
      if (t.dataset.review === 'comp') void showComp(e, t.value);
    });
    el.addEventListener('click', (ev) => {
      const cmd = (ev.target as HTMLElement).closest<HTMLElement>('[data-review-command]')?.dataset.reviewCommand;
      if (cmd) void e.runCommand(cmd);
    });
  }
  const doc = e.doc;
  const artboards = doc.layers.filter((l) => l.artboard);
  const comps = doc.layerComps ?? [];
  el.innerHTML = `<span class="review-title">${svg('share-review', 15)}<strong>${escapeXML(doc.name)}</strong><span class="muted">${cs.client.canComment ? 'Review · you can comment' : 'Review · view only'}</span></span>${
    artboards.length ? `<label>Artboard <select data-review="artboard"><option value="">Whole document</option>${artboards.map((a) => `<option value="${a.id}">${escapeXML(a.name)}</option>`).join('')}</select></label>` : ''
  }${comps.length ? `<label>Layer comp <select data-review="comp"><option value="">As shared</option>${comps.map((c) => `<option value="${escapeXML(c.id)}">${escapeXML(c.name)}</option>`).join('')}</select></label>` : ''}<span class="panel-tabs-spacer"></span><button data-review-command="view.fit">${svg('maximize', 14)}Fit</button><button data-review-command="view.actual-pixels">100%</button>${cs.client.canComment ? `<button data-review-command="comments.new">${svg('comment-add', 14)}Comment</button>` : ''}`;
}
/** Show a layer comp in the review view (this browser only; nothing is changed). */
let reviewComp = '';
async function showComp(e: Editor, id: string) {
  reviewComp = id;
  const comp = e.doc.layerComps?.find((c) => c.id === id);
  if (!comp) {
    reviewComp = '';
    e.preview(e.doc);
    return;
  }
  const { applyLayerComp } = await import('../../model/layer-comps');
  const draft = structuredClone(e.doc);
  applyLayerComp(draft, comp);
  e.normalizePixelLayers(draft, e.assets);
  e.preview(draft);
}
