import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { checkedBookmarkName } from '../engine/bookmarks.js';

export function openBookmarks({ entries, add, rename, remove, navigate }) {
  const name = el('input.input', { 'aria-label': 'Bookmark name', maxLength: 40, spellcheck: false });
  const list = el('select.input', { 'aria-label': 'Document bookmarks', size: 6, style: { backgroundImage: 'none' } });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const validate = action => {
    try {
      checkedBookmarkName(name.value);
      // Names starting with an underscore are hidden bookmarks (tables of contents, cross-references), which this list leaves out.
      if (name.value.startsWith('_')) throw new Error('Start the name with a letter. Names that start with an underscore are hidden bookmarks.');
      // Add with a name already in use moves that bookmark to the selection, as desktop word processors do.
      if (action === 'rename' && entries().some(e => e.name?.toLowerCase() === name.value.toLowerCase() && e.id !== list.value)) throw new Error('A bookmark with that name already exists.');
    } catch (e) { error.hidden = false; error.textContent = e.message; return; }
    const moved = action === 'add' && entries().find(e => e.name?.toLowerCase() === name.value.toLowerCase());
    if (action === 'add' ? add(name.value, { move: true }) : rename(list.value, name.value)) {
      refresh(); error.hidden = true;
      // The moved bookmark is the one chosen in the list, so Go to bookmark goes to its new place.
      if (moved) { const now = entries().find(e => e.name?.toLowerCase() === name.value.toLowerCase()); if (now) { list.value = now.id; update(); } }
    }
  };
  const renameButton = el('button.btn', { type: 'button', onclick: () => validate('rename') }, 'Rename');
  const removeButton = el('button.btn', { type: 'button', onclick: () => { remove(list.value); refresh(); } }, 'Delete bookmark');
  const go = el('button.btn', { type: 'button', onclick: () => { const id = list.value; modal.close(); navigate(id); } }, 'Go to bookmark');
  const update = () => { const item = entries().find(e => e.id === list.value); if (item) name.value = item.name; for (const b of [renameButton, removeButton, go]) b.disabled = !item; };
  const refresh = () => { const id = list.value; list.replaceChildren(...entries().map(e => el('option', { value: e.id }, `${e.name || '(unnamed)'} · page ${e.page}`))); list.value = id; update(); };
  list.addEventListener('change', update); refresh();
  const content = el('form.bookmark-form', { onsubmit: e => { e.preventDefault(); validate('add'); } },
    el('label.field', {}, el('span.field-label', {}, 'Name'), name),
    el('p.field-hint', {}, 'Add a bookmark at the caret or around selected text. Use 1–40 letters, numbers or underscores, starting with a letter.'), error,
    el('div.row', {}, el('button.btn.btn-primary', { type: 'submit' }, 'Add bookmark'), renameButton),
    el('label.field', {}, el('span.field-label', {}, 'Bookmarks'), list),
    el('div.row.row-end', {}, go, removeButton, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Done')));
  const modal = openModal({ title: 'Bookmarks', content }); name.focus(); return modal;
}
