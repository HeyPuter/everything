// Comments panel: review threads of the active document, filtered (open,
// resolved, mine, all), with replies, @mentions, resolve and reopen, edits
// and removal of one's own messages, and a click to zoom to a pin.
import './collab.css';
import type { Editor } from '../../editor';
import type { Panel } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { isRegion, LIMITS, type CommentFilter, type CommentThread } from '../../collab/comments';
import { commentsOf, sharedOf, view, visibleThreads } from './state';
import { formDialog } from '../../ui/dialog';

const filters: [CommentFilter, string][] = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['mine', 'Mine'],
  ['all', 'All'],
];
// Message being edited, and unsent replies by thread (kept across redraws).
let editing = '';
const replies = new Map<string, string>();
let draftText = '';

function when(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
/** Message text with @mentions marked (escaped). */
export function richText(text: string) {
  return escapeXML(text).replace(/(^|[^\w@])@([A-Za-z0-9._-]{1,64})/g, (_, pre, name) => `${pre}<span class="comment-mention">@${name}</span>`);
}
/** Names that can be mentioned: people in a shared document. */
function mentionable(e: Editor): string[] {
  return sharedOf(e.session)?.people?.() ?? [];
}

function threadHtml(e: Editor, t: CommentThread, n: number) {
  const store = commentsOf(e);
  const me = store.me().id;
  const selected = view.selected === t.id;
  const first = t.messages.find((m) => !m.deleted) ?? t.messages[0];
  const where = isRegion(t.anchor) ? `Region ${t.anchor.width} × ${t.anchor.height}` : `Point ${t.anchor.x}, ${t.anchor.y}`;
  const head = `<div class="comment-head" data-open="${t.id}"><button class="comment-number" data-locate="${t.id}" title="Show on canvas (${where})" aria-label="Comment ${n}: show on canvas">${n}</button><span class="comment-author">${escapeXML(t.author.name)}</span><span class="muted comment-time">${when(t.created)}</span>${t.resolved ? `<span class="comment-badge" title="Resolved by ${escapeXML(t.resolved.by.name)}">${svg('check', 12)}Resolved</span>` : ''}<span class="panel-tabs-spacer"></span><button class="icon-button comment-toggle" data-open="${t.id}" aria-expanded="${selected}" aria-label="${selected ? 'Collapse' : 'Open'} comment ${n}" title="${selected ? 'Collapse' : 'Open thread'}">${svg(selected ? 'chevron-down' : 'chevron-right', 14)}</button></div>`;
  if (!selected) {
    const more = t.messages.filter((m) => !m.deleted).length - 1;
    return `<li class="comment-thread${t.resolved ? ' resolved' : ''}" data-thread="${t.id}">${head}<div class="comment-text" data-open="${t.id}">${first ? (first.deleted ? '<em class="muted">Removed</em>' : richText(first.text)) : ''}</div>${more > 0 ? `<div class="muted comment-replies">${more} repl${more === 1 ? 'y' : 'ies'}</div>` : ''}</li>`;
  }
  const can = store.canComment();
  const owner = sharedOf(e.session)?.role === 'owner' || !store.shared;
  const msgs = t.messages
    .map((m) => {
      if (m.deleted) return `<div class="comment-message removed muted"><em>Message removed</em></div>`;
      const mine = m.author.id === me;
      const actions =
        can && (mine || owner)
          ? `<span class="comment-actions">${mine ? `<button class="icon-button" data-edit="${m.id}" aria-label="Edit message" title="Edit">${svg('pen-line', 13)}</button>` : ''}<button class="icon-button" data-remove="${m.id}" aria-label="Remove message" title="Remove">${svg('trash-2', 13)}</button></span>`
          : '';
      const body =
        editing === m.id
          ? `<textarea class="comment-input" data-editing="${m.id}" aria-label="Edit message" maxlength="${LIMITS.text}">${escapeXML(m.text)}</textarea><div class="comment-buttons"><button data-cancel-edit>Cancel</button><button class="primary" data-save-edit="${m.id}">Save</button></div>`
          : `<div class="comment-text">${richText(m.text)}${m.edited ? ' <span class="muted">(edited)</span>' : ''}</div>`;
      return `<div class="comment-message"><div class="comment-meta"><span class="comment-author">${escapeXML(m.author.name)}</span><span class="muted comment-time">${when(m.created)}</span>${actions}</div>${body}</div>`;
    })
    .join('');
  const reply = can
    ? `<textarea class="comment-input" data-reply="${t.id}" aria-label="Reply" placeholder="Reply… (@ to mention)" maxlength="${LIMITS.text}">${escapeXML(replies.get(t.id) ?? '')}</textarea><div class="comment-suggest" data-suggest-for="reply"></div><div class="comment-buttons"><button data-resolve="${t.id}">${svg(t.resolved ? 'rotate-ccw' : 'check', 13)}${t.resolved ? 'Reopen' : 'Resolve'}</button>${t.author.id === me || owner ? `<button data-remove-thread="${t.id}" aria-label="Remove comment">${svg('trash-2', 13)}</button>` : ''}<span class="panel-tabs-spacer"></span><button class="primary" data-send="${t.id}">Reply</button></div>`
    : '';
  return `<li class="comment-thread selected${t.resolved ? ' resolved' : ''}" data-thread="${t.id}">${head}${msgs}${reply}</li>`;
}

function panelHtml(e: Editor) {
  const store = commentsOf(e);
  const all = store.threads().filter((t) => !t.deleted);
  const list = visibleThreads(e);
  const number = new Map(all.map((t, i) => [t.id, i + 1]));
  const tabs = filters.map(([f, label]) => `<button data-filter="${f}" aria-pressed="${view.filter === f}">${label}</button>`).join('');
  const can = store.canComment() && e.hasDocument;
  const draft = view.draft
    ? `<div class="comment-draft"><div class="muted">New comment on ${view.draft.width ? `a ${view.draft.width} × ${view.draft.height} region` : `the point ${view.draft.x}, ${view.draft.y}`}</div><textarea class="comment-input" id="comment-draft" aria-label="New comment" placeholder="Write a comment… (@ to mention)" maxlength="${LIMITS.text}">${escapeXML(draftText)}</textarea><div class="comment-suggest" data-suggest-for="draft"></div><div class="comment-buttons"><button data-cancel-draft>Cancel</button><span class="panel-tabs-spacer"></span><button class="primary" data-post>Comment</button></div></div>`
    : '';
  const empty = !e.hasDocument
    ? '<p class="muted">Open a document to review it with comments.</p>'
    : all.length
      ? `<p class="muted">No ${view.filter === 'all' ? '' : `${filters.find(([f]) => f === view.filter)![1].toLowerCase()} `}comments.</p>`
      : `<p class="muted">No comments yet.${can ? ' Choose New Comment, then click the image to pin one or drag to comment on a region.' : ''}</p>`;
  const sh = sharedOf(e.session);
  const scope = sh ? `<p class="muted comment-scope">${sh.role === 'viewer' ? 'You can read comments on this shared document.' : 'Comments are shared with everyone on this document.'}</p>` : '';
  return `<div class="comments-head"><div class="comments-filter" role="group" aria-label="Show comments">${tabs}</div><button class="icon-button" data-command="comments.new" title="New comment" aria-label="New comment" ${can ? '' : 'disabled'}>${svg('comment-add', 16)}</button></div>${draft}${list.length ? `<ul class="comments-list">${list.map((t) => threadHtml(e, t, number.get(t.id) ?? 0)).join('')}</ul>` : empty}${scope}`;
}

/** Center the view on a thread's pin (and fit a region) and open it. */
export function revealThread(e: Editor, id: string, zoom = true) {
  const t = commentsOf(e).threads().find((x) => x.id === id);
  if (!t) return;
  view.selected = id;
  if (zoom) {
    const vp = e.viewportSize();
    const fit = isRegion(t.anchor) ? Math.min(32, Math.max(0.05, Math.min((vp.width * 0.6) / t.anchor.width!, (vp.height * 0.6) / t.anchor.height!))) : e.zoom;
    const cx = t.anchor.x + (t.anchor.width ?? 0) / 2,
      cy = t.anchor.y + (t.anchor.height ?? 0) / 2;
    e.zoomBy(fit, undefined, undefined, [cx, cy]);
  }
  e.overlay();
  e.dock.update();
}
export function focusComposer(e: Editor) {
  requestAnimationFrame(() => e.root.querySelector<HTMLTextAreaElement>('#comment-draft')?.focus());
}

function suggest(e: Editor, input: HTMLTextAreaElement) {
  const box = input.parentElement?.querySelector<HTMLElement>(`.comment-suggest`);
  if (!box) return;
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(?:^|[^\w@])@([A-Za-z0-9._-]{0,64})$/.exec(before);
  const names = m ? mentionable(e).filter((n) => n.toLowerCase().startsWith(m[1].toLowerCase()) && n !== commentsOf(e).me().name).slice(0, 6) : [];
  box.innerHTML = names.map((n) => `<button type="button" data-mention="${escapeXML(n)}">@${escapeXML(n)}</button>`).join('');
}

export const commentsPanel: Pick<Panel, 'mount' | 'update' | 'menu'> = {
  mount: (e, el) => {
    el.classList.add('comments-panel');
    const run = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        e.message(error instanceof Error ? error.message : String(error));
      }
      delete el.dataset.key;
      e.overlay();
      e.dock.update();
    };
    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLTextAreaElement;
      if (t.id === 'comment-draft') draftText = t.value;
      if (t.dataset.reply) replies.set(t.dataset.reply, t.value);
      if (t.matches('.comment-input')) suggest(e, t);
    });
    el.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLElement;
      // Mod+Enter sends; Escape leaves the field.
      if (t.matches('.comment-input') && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        const send = t.closest('.comment-draft')?.querySelector<HTMLButtonElement>('[data-post]') ?? t.parentElement?.querySelector<HTMLButtonElement>('[data-send],[data-save-edit]');
        send?.click();
      }
    });
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const store = commentsOf(e);
      const get = (attr: string) => target.closest<HTMLElement>(`[data-${attr}]`)?.dataset[attr.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
      const mention = get('mention');
      if (mention) {
        const input = target.closest('.comment-thread,.comment-draft')?.querySelector<HTMLTextAreaElement>('.comment-input');
        if (input) {
          const at = input.selectionStart ?? input.value.length;
          const before = input.value.slice(0, at).replace(/@([A-Za-z0-9._-]{0,64})$/, `@${mention} `);
          input.value = before + input.value.slice(at);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          input.setSelectionRange(before.length, before.length);
        }
        return;
      }
      const filter = get('filter');
      if (filter) return run(() => (view.filter = filter as CommentFilter));
      const locate = get('locate');
      if (locate) return run(() => revealThread(e, locate));
      const open = get('open');
      if (open) return run(() => (view.selected = view.selected === open ? '' : open));
      if (target.closest('[data-cancel-draft]')) return run(() => ((view.draft = null), (draftText = '')));
      if (target.closest('[data-post]')) {
        const text = draftText.trim();
        if (!text || !view.draft) return;
        return run(() => {
          const t = store.add(view.draft!, text, e.selected || undefined);
          view.draft = null;
          draftText = '';
          view.selected = t.id;
          if (view.filter === 'resolved') view.filter = 'open';
        });
      }
      const send = get('send');
      if (send) {
        const text = (replies.get(send) ?? '').trim();
        if (!text) return;
        return run(() => {
          store.reply(send, text);
          replies.delete(send);
        });
      }
      const resolve = get('resolve');
      if (resolve) return run(() => store.resolve(resolve, !store.threads().find((t) => t.id === resolve)?.resolved));
      const removeThread = get('remove-thread');
      if (removeThread) {
        void formDialog('Remove comment?', [], 'Remove', 'The comment and its replies are removed for everyone who can see this document.').then(
          (ok) =>
            ok &&
            run(() => {
              store.remove(removeThread);
              view.selected = '';
            }),
        );
        return;
      }
      const thread = target.closest<HTMLElement>('[data-thread]')?.dataset.thread;
      const remove = get('remove');
      if (remove && thread) return run(() => store.remove(thread, remove));
      const edit = get('edit');
      if (edit) return run(() => (editing = edit));
      if (target.closest('[data-cancel-edit]')) return run(() => (editing = ''));
      const save = get('save-edit');
      if (save && thread) {
        const text = el.querySelector<HTMLTextAreaElement>(`[data-editing="${save}"]`)?.value.trim();
        if (!text) return;
        return run(() => {
          store.edit(thread, save, text);
          editing = '';
        });
      }
    });
  },
  update: (e, el) => {
    const store = commentsOf(e);
    const key = JSON.stringify([e.session.id, store.version, store.threads().length, view.filter, view.selected, view.draft, editing, e.hasDocument, store.canComment(), sharedOf(e.session)?.role]);
    if (el.dataset.key === key) return;
    // Keep typing undisturbed: redraw once the field loses focus.
    const focused = el.contains(document.activeElement) && document.activeElement?.matches('textarea');
    if (focused && el.dataset.session === e.session.id && el.dataset.selected === view.selected && !!el.querySelector('#comment-draft') === !!view.draft) {
      el.addEventListener('focusout', () => setTimeout(() => !el.contains(document.activeElement) && e.dock.update(), 0), { once: true });
      return;
    }
    el.dataset.key = key;
    el.dataset.session = e.session.id;
    el.dataset.selected = view.selected;
    el.innerHTML = panelHtml(e);
    el.querySelector('.comment-thread.selected')?.scrollIntoView({ block: 'nearest' });
  },
  menu: () => ['comments.new', '-', 'view.show-comments', '-', 'file.share-for-review'],
};
