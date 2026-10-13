// Small, always-loaded state for comments and shared documents: each open
// document's comment store, which documents are shared (the collaboration
// module registers them when it loads), and the comment pins drawn over the
// canvas. Pins are an overlay, so exports never contain them.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { escapeXML } from '../../model/assets';
import { projectExtras } from '../../model/serialization';
import { LocalComments, type CommentStore } from '../../collab/comment-store';
import { filterThreads, isRegion, validateComments, type CommentAuthor, type CommentFilter, type CommentThread } from '../../collab/comments';

/** What the always-loaded code needs from a shared document's controller. */
export interface SharedHandle {
  comments: CommentStore;
  /** Presence of other people, drawn over the canvas (document markup). */
  overlay(e: Editor): string;
  role: string;
  review: boolean;
  /** Names of the document's members (for @mentions). */
  people?(): string[];
}
export const shared = new Map<DocumentSession, SharedHandle>();
export const sharedOf = (s: DocumentSession) => shared.get(s);

const local = new WeakMap<DocumentSession, LocalComments>();
let puterName = '';
/** The name local comments are signed with: the Puter account when signed in. */
export function localAuthor(): CommentAuthor {
  if (!puterName) {
    const p = (globalThis as { puter?: { auth?: { isSignedIn?: () => boolean; getUser?: () => Promise<{ username?: string }> } } }).puter;
    try {
      if (p?.auth?.isSignedIn?.())
        void p.auth.getUser?.().then(
          (u) => (puterName = u?.username ?? ''),
          () => {},
        );
    } catch {
      /* Optional. */
    }
  }
  let name = puterName;
  if (!name)
    try {
      name = localStorage.getItem('photo-studio-note-author') || '';
    } catch {
      /* Optional. */
    }
  name = (name || 'You').slice(0, 80);
  return { id: `local:${name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'me'}`, name };
}

/** The comments of a document (created on first use from the opened file). */
export function commentsOf(e: Editor, s: DocumentSession = e.session): CommentStore {
  const sh = shared.get(s);
  if (sh) return sh.comments;
  let store = local.get(s);
  if (!store) {
    let initial: CommentThread[] = [];
    try {
      initial = validateComments((s.doc as { comments?: unknown }).comments) ?? [];
    } catch {
      /* A malformed list is dropped; the rest of the document opened. */
    }
    store = makeLocal(e, s, initial);
    local.set(s, store);
  }
  // Saving writes the current comments into the project (see serialize).
  const st = store;
  projectExtras.set(s.assets, (doc) => (doc.id === s.doc.id ? { comments: st.threads().length ? structuredClone(st.threads()) : undefined } : {}));
  return store;
}
/** Give a session local comments (a shared document became a local copy). */
export function adoptLocalComments(e: Editor, s: DocumentSession, threads: CommentThread[]) {
  local.set(s, makeLocal(e, s, threads));
  commentsOf(e, s);
  s.unsavedExtras = threads.length > 0;
}
function makeLocal(e: Editor, s: DocumentSession, initial: CommentThread[]) {
  return new LocalComments(initial, localAuthor, () => {
    s.unsavedExtras = true;
    e.overlay();
    e.windows.renderTabs();
    e.dock?.update();
  });
}
/** Forget a session's local comments (it became shared, or closed). */
export function dropLocalComments(s: DocumentSession) {
  local.delete(s);
}

// ----- View state -----

export const view = {
  filter: 'open' as CommentFilter,
  selected: '' as string,
  hidden: false,
  // A region being dragged with the Comment tool, and a placed draft waiting for its text.
  dragging: null as null | { x: number; y: number; width: number; height: number },
  draft: null as null | { x: number; y: number; width?: number; height?: number },
};
export function visibleThreads(e: Editor) {
  const store = commentsOf(e);
  return filterThreads(store.threads(), view.filter, store.me());
}

const px = (e: Editor, n: number) => n / e.zoom;
function pin(e: Editor, t: { anchor: CommentThread['anchor'] } | null, n: string, selected: boolean, resolved: boolean, anchor = t!.anchor) {
  const r = px(e, 11),
    w = px(e, 1.5);
  const fill = resolved ? '#4b5563' : '#1e5aa8';
  const region = isRegion(anchor)
    ? `<rect x="${anchor.x}" y="${anchor.y}" width="${anchor.width}" height="${anchor.height}" fill="${selected ? '#1e5aa822' : 'none'}" stroke="${fill}" stroke-width="${w}" stroke-dasharray="${px(e, 5)} ${px(e, 3)}"/>`
    : '';
  // A round pin with its number and a tail whose tip marks the point.
  const cx = anchor.x + r * 1.1,
    cy = anchor.y - r * 1.1;
  const stroke = selected ? '#fff' : '#000a',
    sw = selected ? w * 1.6 : w;
  return `${region}<g class="comment-pin${selected ? ' selected' : ''}"><path d="M${anchor.x} ${anchor.y}L${anchor.x + r * 1.1} ${anchor.y - r * 0.45}L${anchor.x + r * 0.45} ${anchor.y - r * 1.1}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/><text x="${cx}" y="${cy}" fill="#fff" font-size="${px(e, n.length > 2 ? 8 : 10)}" font-weight="600" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif">${escapeXML(n)}</text></g>`;
}
/** Comment pins over the canvas (never part of the image). */
export function commentsOverlay(e: Editor): string {
  if (!e.hasDocument || view.hidden) return '';
  let out = '';
  const all = commentsOf(e).threads().filter((t) => !t.deleted);
  const shown = new Set(visibleThreads(e).map((t) => t.id));
  all.forEach((t, i) => {
    if (shown.has(t.id) || t.id === view.selected) out += pin(e, t, String(i + 1), t.id === view.selected, !!t.resolved);
  });
  if (view.dragging) out += pin(e, null, '+', true, false, view.dragging);
  if (view.draft) out += pin(e, null, '+', true, false, view.draft);
  return out;
}
/** The thread whose pin is under a document point (topmost first). */
export function threadAt(e: Editor, x: number, y: number): CommentThread | undefined {
  const r = px(e, 11);
  const shown = new Set(visibleThreads(e).map((t) => t.id));
  return [...commentsOf(e).threads()]
    .reverse()
    .find((t) => !t.deleted && (shown.has(t.id) || t.id === view.selected) && Math.hypot(x - (t.anchor.x + r * 1.1), y - (t.anchor.y - r * 1.1)) <= r * 1.4);
}
