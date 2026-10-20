import { el, icon, contrastInk } from './lib/ui.js';
import { MAX_COMMENTS, collectComments } from './core/comments.js';

/**
 * The Comments tab of the side panel: every note and markup in the PDF, by page, each a
 * button that goes to its page and opens or selects it.
 */
let metaIds = 0;
export function createCommentsPanel({ onSelect }) {
  const list = el('div', { class: 'comments', role: 'group', 'aria-label': 'Comments' });
  const root = el('div', { class: 'comments-panel', tabindex: -1 }, list);
  let generation = 0,
    count = 0,
    capped = false,
    snapshot = null,
    rendered = [];
  const when = (date) =>
    date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  function render(found) {
    list.replaceChildren();
    // One more than the cap means the scan stopped early; the extra one is not shown.
    capped = found.length > MAX_COMMENTS;
    const comments = capped ? found.slice(0, MAX_COMMENTS) : found;
    count = comments.length;
    rendered = comments;
    if (!comments.length) {
      list.append(
        el(
          'p',
          { class: 'comments-empty muted' },
          'No comments yet. Add a note, or highlight some text, to see it listed here.',
        ),
      );
      return;
    }
    // A heading and a real list per page, so each comment is a button inside a list item.
    let lastPage = -1,
      pageList = null;
    for (const comment of comments) {
      if (comment.page !== lastPage) {
        lastPage = comment.page;
        list.append(el('h3', { class: 'comments-page' }, `Page ${comment.page + 1}`));
        pageList = el('ul', { class: 'comments-list', 'aria-label': `Page ${comment.page + 1}` });
        list.append(pageList);
      }
      const swatch = el(
        'span',
        { class: 'comment-swatch', 'aria-hidden': 'true' },
        icon(comment.icon, 14),
      );
      if (comment.hex) {
        swatch.style.setProperty('--comment-color', comment.hex);
        swatch.style.setProperty('--comment-ink', contrastInk(comment.hex));
      }
      const meta = [comment.author, when(comment.date)].filter(Boolean).join(' · ');
      // The name says what and where; the author and date shown beneath it describe it.
      const metaId = meta ? `comment-meta-${++metaIds}` : null;
      pageList.append(
        el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              class: 'comment-item',
              'data-comment-id': comment.id,
              'data-comment-page': comment.page,
              'aria-label': `${comment.kind} on page ${comment.page + 1}${comment.text ? ': ' + comment.text.slice(0, 80) : ''}`,
              'aria-describedby': metaId,
              onclick: () => onSelect(comment),
            },
            swatch,
            el(
              'span',
              { class: 'comment-body' },
              el('span', { class: 'comment-text' }, comment.text || comment.kind),
              meta && el('span', { class: 'comment-meta', id: metaId }, meta),
            ),
          ),
        ),
      );
    }
    // A PDF with more comments than the list holds says so rather than stopping in silence.
    if (capped)
      list.append(
        el(
          'p',
          { class: 'comments-empty muted' },
          `Only the first ${count.toLocaleString()} comments are listed.`,
        ),
      );
  }
  /**
   * Gather the comments of `pdf`; resolves to how many are listed and whether the PDF holds
   * more than that, or to null when superseded.
   */
  async function load(pdf, { isCurrent = () => true } = {}) {
    const token = ++generation;
    if (!list.firstChild)
      list.append(el('p', { class: 'comments-empty muted' }, 'Looking for comments…'));
    const comments = await collectComments(pdf, {
      isCurrent: () => token === generation && isCurrent(),
    });
    if (token !== generation || !isCurrent() || !comments) return null;
    const nextSnapshot = JSON.stringify(comments);
    if (nextSnapshot !== snapshot) {
      const scrollTop = root.scrollTop;
      const focusedIndex = [...list.querySelectorAll('.comment-item')].indexOf(
        document.activeElement,
      );
      const focused = rendered[focusedIndex];
      const sharedFocus =
        focused && rendered.some((item) => item !== focused && item.id === focused.id);
      const pagePosition =
        focused && rendered.filter((item) => item.page === focused.page).indexOf(focused);
      render(comments);
      root.scrollTop = scrollTop;
      // Undo, redo, or a page operation can replace the focused comment's button.
      // Follow its identity, then its nearest neighbor if it was removed.
      if (focused && document.activeElement === document.body) {
        let index = rendered.findIndex(
          (item) => item.id === focused.id && item.page === focused.page,
        );
        // Editing one instance of a shared annotation changes that instance's ID.
        // Keep its place on this page instead of following the old ID to another page.
        if (index < 0 && sharedFocus) {
          const replacement = rendered.filter((item) => item.page === focused.page)[pagePosition];
          index = rendered.indexOf(replacement);
        }
        if (index < 0) index = rendered.findIndex((item) => item.id === focused.id);
        if (index < 0) index = Math.min(focusedIndex, rendered.length - 1);
        (list.querySelectorAll('.comment-item')[index] || root).focus({ preventScroll: true });
      }
      snapshot = nextSnapshot;
    }
    return { total: count, capped };
  }
  return {
    el: root,
    load,
    get count() {
      return count;
    },
  };
}
