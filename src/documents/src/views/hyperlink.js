import { el } from '../ui/dom.js';
import { openPopover } from '../ui/popover.js';
import { checkedHyperlinkTarget, internalHyperlink, openableHyperlink } from '../engine/hyperlinks.js';
import { hrefForToken } from '../lib/linkify.js';

export function openHyperlink({ link, bookmarks = [], insert, apply, remove, open, anchor, focusFirst = true }) {
  const kind = el('select.input', { 'aria-label': 'Link destination type' }, el('option', { value: 'address' }, 'Address'), el('option', { value: 'bookmark' }, 'Bookmark'));
  kind.value = internalHyperlink(link) ? 'bookmark' : 'address';
  // Hidden bookmarks (_Toc…, _Ref…, _GoBack: those tables of contents and cross-references make) are left out, as in
  // the Bookmarks dialog; a link that already goes to one keeps it.
  const choices = [...new Set(bookmarks.map(b => b.name).filter(name => !name?.startsWith('_')))];
  if (internalHyperlink(link) && link.anchor !== null && !choices.includes(link.anchor)) choices.push(link.anchor);
  const bookmark = el('select.input', { 'aria-label': 'Link bookmark' }, el('option', { value: 'null' }, 'Start of document'), ...choices.map(name => el('option', { value: JSON.stringify(name) }, name || '(unnamed)')));
  bookmark.value = internalHyperlink(link) ? JSON.stringify(link.anchor) : 'null';
  const target = el('input.input', { 'aria-label': 'Link address', value: link?.target || '', required: true, spellcheck: false, placeholder: 'https://example.com' });
  const addressField = el('label.field', {}, el('span.field-label', {}, 'Address'), target), bookmarkField = el('label.field', {}, el('span.field-label', {}, 'Bookmark'), bookmark);
  const update = () => { addressField.hidden = kind.value !== 'address'; target.required = kind.value === 'address'; bookmarkField.hidden = kind.value !== 'bookmark'; };
  kind.addEventListener('change', update); update();
  const text = insert ? el('input.input', { 'aria-label': 'Link text', placeholder: 'Use the link address' }) : null;
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const retained = !!link && !openableHyperlink(link);
  const content = el('form', { onsubmit: e => {
    e.preventDefault();
    // A typed "example.com" or "joe@example.com" links as it would when typed in the document.
    const typed = target.value.trim();
    // An imported address this editor can't open stays as it is when left unchanged.
    if (retained && kind.value === 'address' && typed === link.target) { modal.close(); return; }
    const destination = kind.value === 'bookmark' ? { anchor: JSON.parse(bookmark.value) } : hrefForToken(typed) || typed;
    try { if (typeof destination === 'string') checkedHyperlinkTarget(destination); } catch (e) { error.textContent = e.message; error.hidden = false; target.setAttribute('aria-invalid', 'true'); target.focus(); return; }
    modal.close(); apply(destination, text?.value || (typeof destination === 'string' ? typed : destination.anchor || 'Start of document'));
  } },
  el('label.field', {}, el('span.field-label', {}, 'Destination'), kind), addressField, bookmarkField,
  text ? el('label.field', {}, el('span.field-label', {}, 'Text'), text) : null,
  el('p.field-hint', {}, retained ? 'This link points to a file or address that can’t be opened here. It is kept as it is unless you change it.' : 'Paste a web or email address, or choose a bookmark in this document.'), error,
  el('div.row.row-end', {},
    link && !retained ? el('button.btn.btn-ghost', { type: 'button', onclick: () => { if (internalHyperlink(link)) modal.close(); open(); } }, 'Open link') : null,
    link ? el('button.btn.btn-ghost', { type: 'button', onclick: () => { modal.close(); remove(); } }, 'Remove link') : null,
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
    el('button.btn.btn-primary', { type: 'submit' }, 'Apply')));
  const modal = openPopover({ anchor, label: link ? 'Edit link' : 'Insert link', content, focusFirst });
  if (focusFirst && modal.menu) (internalHyperlink(link) ? bookmark : target).focus(); return modal;
}
