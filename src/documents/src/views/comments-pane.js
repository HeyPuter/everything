/**
 * The Comments pane: every comment thread as a list, filtered by author, by resolved state or by
 * text, with @mentions highlighted. Choosing a thread selects its text and its card.
 */
import { el, listItem, relativeTime } from '../ui/dom.js';
import { sidePane, preference } from './review-ui.js';
import { commentThreads, avatarColor } from './review.js';
import { initialsFor } from '../engine/comments.js';
import { mentionsIn, renderMentions } from './mentions.js';

const SHOW_RESOLVED = preference('documents:comments-pane-resolved', true);

export function createCommentsPane({ editor, review, people }) {
  let author = '', query = '';
  const pane = sidePane({ title: 'Comments', label: 'Comments pane', className: 'rv-comments-pane', onOpen: () => render(), onClose: () => editor()?.focus() });
  const authorSelect = el('select.input', { 'aria-label': 'Show comments by or mentioning', onchange: () => { author = authorSelect.value; render(); } });
  const search = el('input.input', { type: 'search', placeholder: 'Search comments', 'aria-label': 'Search comments', oninput: () => { query = search.value.trim().toLowerCase(); render(); } });
  const resolved = el('input', { type: 'checkbox', checked: SHOW_RESOLVED.get(), onchange: () => { SHOW_RESOLVED.set(resolved.checked); render(); } });
  const list = el('div.rv-list.rv-comment-list', { role: 'list', 'aria-label': 'Comments' });
  const count = el('p.rv-status', { role: 'status' });
  const newComment = el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => review.commands.newComment() }, 'New Comment');
  pane.body.append(el('div.rv-filters', {}, authorSelect, search), el('label.rv-check', {}, resolved, 'Show resolved comments'), el('div.rv-actions', {}, newComment), count, list);

  const threads = () => { const engine = editor(); return engine?.model.comments ? commentThreads(engine.session.body.commentList) : []; };
  let signature = '';
  function render(force = true) {
    if (!pane.isOpen) return;
    const all = threads();
    // Anchor offsets are left out: the list does not show them (a chosen thread is selected where it is now),
    // and typing before a comment would otherwise rebuild the whole list at every keystroke.
    const next = JSON.stringify([all.map(t => [t.id, t.root, t.replies]), author, query, resolved.checked, review.commands.activeThread()?.id, review.commands.canComment()], (key, value) => key === 'start' || key === 'end' ? undefined : value);
    if (!force && next === signature) return;
    signature = next;
    const names = people();
    // Authors, and people mentioned in comments: filtering by someone shows what involves them.
    const authors = [...new Set(all.flatMap(t => [t.root, ...t.replies].flatMap(c => [c.author, ...mentionsIn(c.text, names)])).filter(Boolean))];
    if (author && !authors.includes(author)) author = '';
    authorSelect.replaceChildren(el('option', { value: '' }, 'All people'), ...authors.map(name => el('option', { value: name, selected: name === author }, name)));
    const shown = all.filter(t => (resolved.checked || !t.root.done)
      && (!author || [t.root, ...t.replies].some(c => c.author === author || mentionsIn(c.text, names).includes(author)))
      && (!query || [t.root, ...t.replies].some(c => `${c.author} ${c.text}`.toLowerCase().includes(query))));
    count.textContent = all.length ? `${shown.length} of ${all.length} ${all.length === 1 ? 'thread' : 'threads'}` : 'No comments yet.';
    const active = review.commands.activeThread()?.id;
    newComment.disabled = !review.commands.canComment();
    list.replaceChildren(...shown.map(t => {
      const when = Date.parse(t.root.date);
      return listItem(el(`button.rv-comment${t.root.done ? '.is-resolved' : ''}`, { type: 'button', 'aria-current': String(t.id === active), onclick: () => review.commands.selectThreadById(t.id) },
        el('span.rv-comment-head', {}, el('span.wcc-avatar', { 'aria-hidden': 'true', style: { background: avatarColor(t.root.author) } }, (t.root.initials || initialsFor(t.root.author) || '?').slice(0, 2)),
          el('strong', {}, t.root.author || 'Unknown author'), el('span.rv-comment-date', {}, Number.isFinite(when) ? relativeTime(when) : ''), t.root.done ? el('span.rv-badge', {}, 'Resolved') : null),
        el('span.rv-comment-text', {}, ...renderMentions(t.root.text, names)),
        t.replies.length ? el('span.rv-comment-replies', {}, `${t.replies.length} ${t.replies.length === 1 ? 'reply' : 'replies'}`) : null));
    }));
  }
  return { pane, open() { pane.open(); render(); }, refresh() { render(false); }, get filterAuthor() { return author; }, destroy() { pane.destroy(); } };
}
