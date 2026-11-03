// Journey "Photo book" tab: the journey's books, a new-book flow and the editor.
import './book.css';
import { el } from '../../../ui/dom.js';
import { button, emptyState } from '../../../ui/bits.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { can } from '../../../shared/perms.js';
import { roleIn } from '../../trip/members/logic.js';
import { errorText, uidOf } from '../spaces.js';
import { openBookForm } from './create.js';
import { booksOf, createBook, mountEditor } from './editor.js';

const storageKey = (sid) => `trips:book:${sid}`;
function lastBook(sid) { try { return JSON.parse(localStorage.getItem(storageKey(sid)) ?? '{}')?.book ?? null; } catch { return null; } }
function rememberBook(sid, book) { try { localStorage.setItem(storageKey(sid), JSON.stringify({ book, sheet: 0 })); } catch { /* storage may be off */ } }

/** `mount(container, {space, context, ref, signal})` from the journey page. Returns a cleanup function. */
export function mount(container, { space, context, ref }) {
  const root = el('div.bk-root');
  container.replaceChildren(root);
  const me = uidOf(context);
  let editor = null;
  let bookId = null;
  let destroyed = false;
  let creating = false;
  const canEdit = () => can(roleIn(space, me), 'plan.edit', space.get('meta', 'meta')?.perms ?? {});

  function show(next) {
    if (destroyed) return;
    const books = booksOf(space);
    const id = next ?? (books.some((book) => book.id === lastBook(ref.s)) ? lastBook(ref.s) : books.at(-1)?.id ?? null);
    if (id && id === bookId && editor) return;
    editor?.destroy();
    editor = null;
    bookId = id && books.some((book) => book.id === id) ? id : null;
    if (!bookId) { renderEmpty(); return; }
    if (next) rememberBook(ref.s, bookId);
    editor = mountEditor(root, { space, context, ref, bookId, onSwitch: (other) => show(other) });
  }

  function renderEmpty() {
    const action = canEdit() ? button(t('book.create'), { variant: 'primary', icon: 'plus', onclick: () => void create() }) : null;
    root.replaceChildren(emptyState({ title: t('book.emptyTitle'), body: t(canEdit() ? 'book.emptyBody' : 'book.emptyViewer'), icon: 'file', action }));
  }

  async function create() {
    if (creating) return;
    const values = await openBookForm({ title: space.get('meta', 'meta')?.title ?? '' });
    if (!values || destroyed) return;
    creating = true;
    try { show(await createBook(space, values)); } catch (error) { toast(errorText(error)); } finally { creating = false; }
  }

  // A book created or deleted elsewhere changes what this tab shows.
  const off = space.subscribe('book', () => {
    const books = booksOf(space);
    if (!bookId && books.length) show(null);
    else if (bookId && !books.some((book) => book.id === bookId)) show(null);
  });
  show(null);
  return () => { destroyed = true; off(); editor?.destroy(); };
}
