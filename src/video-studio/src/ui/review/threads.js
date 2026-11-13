/**
 * Comment threads, shared by the review page and the editor's Review panel:
 * each thread shows its time (a button that seeks there), author, text and
 * replies, with Reply, Resolve or Reopen, Edit and Delete where allowed.
 * Reply and edit drafts survive re-renders while comments sync.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { pinLabel, spokenAt } from '../../review/time.js';
import { canComment, canResolve, LIMITS, textProblem } from '../../review/protocol.js';
import { canEditComment, canDeleteComment, relativeTime } from '../../review/comments.js';

/** Submit a form the way pressing its submit button would (once). */
export function submitForm(form) {
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/**
 * createThreadList({ onSeek(thread), onReply(thread, text), onResolve(thread, resolved),
 *   onEdit(comment, text), onDelete(comment) }) -> { el, update(threads, opts) }
 * opts: { fps, me, role, activeId, now, empty }
 * Callbacks may return promises; a rejected one keeps the draft and shows the error.
 */
export function createThreadList(handlers) {
  const el = h('ol.rv-threads', { 'aria-label': 'Comments' });
  const replyDrafts = new Map(); // thread id -> text (open reply forms)
  const editDrafts = new Map(); // comment id -> text (open edit forms)
  const errors = new Map(); // form key -> message
  const pending = new Set(); // form keys survive sync re-renders while saving
  let last = { threads: [], opts: {} };

  const textarea = (key, value, label, onInput) => {
    const t = h('textarea.input.rv-textarea', { rows: 2, maxLength: LIMITS.text, 'aria-label': label, dataset: { key } });
    t.value = value;
    t.addEventListener('input', () => onInput(t.value));
    return t;
  };

  function form(key, { label, value, submitLabel, onInput, onCancel, onSubmit }) {
    const input = textarea(key, value, label, onInput);
    const err = h('p.rv-form-error', { role: 'alert' }, errors.get(key) || '');
    const save = h('button.btn.primary.small', { type: 'submit' }, submitLabel);
    const cancel = h('button.btn.small', { type: 'button' }, 'Cancel');
    const f = h('form.rv-inline-form', input, err, h('div.rv-form-actions', cancel, save));
    const setPending = (busy) => {
      input.readOnly = busy;
      save.disabled = cancel.disabled = busy;
      f.setAttribute('aria-busy', String(busy));
    };
    setPending(pending.has(key));
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!pending.has(key)) onCancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitForm(f);
      }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pending.has(key)) return;
      const problem = textProblem(input.value);
      if (problem) {
        errors.set(key, problem);
        err.textContent = problem;
        input.focus();
        return;
      }
      pending.add(key);
      setPending(true);
      try {
        await onSubmit(input.value);
        errors.delete(key);
      } catch (error) {
        pending.delete(key);
        errors.set(key, error?.message || 'Could not save. Try again.');
        render();
        el.querySelector(`textarea[data-key="${CSS.escape(key)}"]`)?.focus();
      } finally {
        pending.delete(key);
      }
    });
    return f;
  }

  function commentBody(c, thread, opts) {
    const { me, role, fps, now } = opts;
    const isThread = !c.parent;
    const head = h('div.rv-comment-head',
      isThread && c.t !== null ? h('button.rv-time', { type: 'button', 'aria-label': `Go to ${spokenAt(c.t)}`, title: 'Go to this time' }, pinLabel(c, fps)) : null,
      h('span.rv-author', c.author?.username || 'Someone'),
      h('span.rv-when', c.pending ? 'Sending...' : relativeTime(c.created, now)),
      c.edited && !c.deleted ? h('span.rv-edited', 'edited') : null,
      isThread && c.resolved ? h('span.rv-badge', icon('check', 12), 'Resolved') : null,
    );
    head.querySelector('.rv-time')?.addEventListener('click', () => handlers.onSeek?.(thread));
    const editing = editDrafts.has(c.id);
    let body;
    if (c.deleted) body = h('p.rv-text.rv-deleted', 'Comment deleted');
    else if (editing) {
      body = form(`edit:${c.id}`, {
        label: 'Edit comment',
        value: editDrafts.get(c.id),
        submitLabel: 'Save',
        onInput: (v) => editDrafts.set(c.id, v),
        onCancel: () => {
          editDrafts.delete(c.id);
          errors.delete(`edit:${c.id}`);
          render();
        },
        onSubmit: async (v) => {
          await handlers.onEdit?.(c, v);
          editDrafts.delete(c.id);
          render();
        },
      });
    } else body = h('p.rv-text', c.text);
    const actions = h('div.rv-actions');
    if (!c.deleted && !c.pending && !editing) {
      if (isThread && canComment(role)) {
        const reply = h('button.rv-action', { type: 'button' }, icon('reply', 14), 'Reply');
        reply.addEventListener('click', () => {
          if (!replyDrafts.has(c.id)) replyDrafts.set(c.id, '');
          render();
          el.querySelector(`textarea[data-key="${CSS.escape(`reply:${c.id}`)}"]`)?.focus();
        });
        actions.append(reply);
      }
      if (isThread && canResolve(role)) {
        const res = h('button.rv-action', { type: 'button', 'aria-pressed': String(Boolean(c.resolved)) }, icon(c.resolved ? 'reset' : 'resolve', 14), c.resolved ? 'Reopen' : 'Resolve');
        res.addEventListener('click', async () => {
          res.disabled = true;
          try {
            await handlers.onResolve?.(thread, !c.resolved);
          } finally {
            res.disabled = false;
          }
        });
        actions.append(res);
      }
      if (canEditComment(c, me) && canComment(role)) {
        const ed = h('button.rv-action', { type: 'button', 'aria-label': 'Edit comment' }, icon('pencil', 14), 'Edit');
        ed.addEventListener('click', () => {
          editDrafts.set(c.id, c.text);
          render();
          el.querySelector(`textarea[data-key="${CSS.escape(`edit:${c.id}`)}"]`)?.focus();
        });
        actions.append(ed);
      }
      if (canDeleteComment(c, me, role) && (canComment(role) || role === 'owner')) {
        const del = h('button.rv-action.danger', { type: 'button', 'aria-label': 'Delete comment' }, icon('trash', 14), 'Delete');
        del.addEventListener('click', () => handlers.onDelete?.(c));
        actions.append(del);
      }
    }
    return h(`article.rv-comment${c.pending ? '.pending' : ''}`, { 'aria-label': `Comment by ${c.author?.username || 'someone'}` }, head, body, actions.childNodes.length ? actions : null);
  }

  function render() {
    const { threads, opts } = last;
    // Keep focus and caret in a draft across re-renders.
    const active = document.activeElement;
    const focusKey = active?.matches?.('textarea[data-key]') && el.contains(active) ? active.dataset.key : null;
    const caret = focusKey ? [active.selectionStart, active.selectionEnd] : null;
    if (!threads.length) {
      el.replaceChildren(h('li.rv-empty', opts.empty || 'No comments yet.'));
      return;
    }
    el.replaceChildren(...threads.map((t) => {
      const replies = t.replies.map((r) => h('li.rv-reply', commentBody(r, t, opts)));
      let replyForm = null;
      if (replyDrafts.has(t.id) && canComment(opts.role) && !t.deleted) {
        replyForm = form(`reply:${t.id}`, {
          label: `Reply to ${t.author?.username || 'comment'}`,
          value: replyDrafts.get(t.id),
          submitLabel: 'Reply',
          onInput: (v) => replyDrafts.set(t.id, v),
          onCancel: () => {
            replyDrafts.delete(t.id);
            errors.delete(`reply:${t.id}`);
            render();
          },
          onSubmit: async (v) => {
            await handlers.onReply?.(t, v);
            replyDrafts.delete(t.id);
            render();
          },
        });
      }
      return h(`li.rv-thread${t.resolved ? '.resolved' : ''}${opts.activeId === t.id ? '.active' : ''}`, { dataset: { id: t.id } },
        commentBody(t, t, opts),
        replies.length ? h('ol.rv-replies', { 'aria-label': 'Replies' }, replies) : null,
        replyForm);
    }));
    if (focusKey) {
      const t = el.querySelector(`textarea[data-key="${CSS.escape(focusKey)}"]`);
      if (t) {
        t.focus();
        if (caret) t.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  return {
    el,
    update(threads, opts = {}) {
      last = { threads, opts: { now: Date.now(), ...opts } };
      render();
    },
    /** Whether a reply or edit draft is open (callers avoid stealing keys then). */
    get editing() {
      return replyDrafts.size + editDrafts.size > 0;
    },
    scrollTo(id) {
      el.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    },
  };
}
