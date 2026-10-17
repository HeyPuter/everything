import { el, typesCharacter } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { chordOf, bindable, displayChord } from './keymap.js';

/**
 * Customize Keyboard: give any command — a ribbon button or a menu item — a shortcut of your own, or
 * take one away. Bindings are kept in this browser. Built-in shortcuts are listed; a custom chord that
 * collides with one takes precedence while the keyboard is in the document.
 */
export function openCustomizeKeyboard({ entries, keymap, onClose, select = null }) {
  const all = dedupe(entries());
  const categories = [...new Set(all.map(e => e.path[0]).filter(Boolean))];
  const category = el('select.input', { 'aria-label': 'Category' }, el('option', { value: '' }, 'All commands'), ...categories.map(c => el('option', { value: c }, c)));
  const filter = el('input.input', { type: 'search', placeholder: 'Search commands', 'aria-label': 'Search commands' });
  const list = el('div.kb-list', { role: 'listbox', 'aria-label': 'Commands', tabindex: 0 });
  const detail = el('div.kb-detail', { 'aria-live': 'polite' });
  let chosen = all.find(e => e.id === select) || null;
  let shown = [];

  function renderList() {
    const q = filter.value.trim().toLowerCase();
    shown = all.filter(e => (!category.value || e.path[0] === category.value) && (!q || `${e.label} ${e.path.join(' ')}`.toLowerCase().includes(q))).slice(0, 400);
    list.replaceChildren(...shown.map((entry, i) => el('div.kb-item', { role: 'option', id: `kb-item-${i}`, 'aria-selected': String(entry === chosen), onclick: () => pick(entry) },
      el('span.kb-label', {}, entry.label), el('span.kb-path', {}, entry.path.filter(Boolean).join(' › ')),
      el('span.kb-keys', {}, [...keymap.chordsFor(entry.id).map(c => displayChord(c)), ...(keymap.isCustom(entry.id) ? [] : entry.shortcut ? [entry.shortcut] : [])].join(', ')))));
    if (!shown.length) list.append(el('p.field-hint', {}, 'No commands match.'));
    const at = shown.indexOf(chosen);
    if (at >= 0) list.setAttribute('aria-activedescendant', `kb-item-${at}`); else list.removeAttribute('aria-activedescendant');
  }
  function pick(entry) { chosen = entry; renderList(); renderDetail(); list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }
  list.addEventListener('keydown', e => {
    const at = shown.indexOf(chosen);
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : null;
    if (next === null || !shown.length) return;
    e.preventDefault(); pick(shown[Math.max(0, Math.min(shown.length - 1, next))]);
  });
  filter.addEventListener('input', renderList);
  category.addEventListener('change', renderList);

  function renderDetail() {
    if (!chosen) { detail.replaceChildren(el('p.field-hint', {}, 'Choose a command to see and change its shortcuts.')); return; }
    const custom = keymap.chordsFor(chosen.id);
    let pending = null;
    const capture = el('input.input.kb-capture', { readOnly: true, placeholder: 'Press the new shortcut', 'aria-label': 'New shortcut', 'aria-describedby': 'kb-capture-hint' });
    const hint = el('p.field-hint', { id: 'kb-capture-hint' }, 'Click here and press the keys, for example Ctrl+Alt+K. Function keys work on their own.');
    const assign = el('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => { if (pending && keymap.assign(chosen.id, pending)) { renderList(); renderDetail(); } } }, 'Assign');
    capture.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return;
      e.preventDefault(); e.stopPropagation();
      const chord = chordOf(e);
      if (!chord) return;
      if (!bindable(chord)) { capture.value = displayChord(chord); hint.textContent = 'Use a modifier key (Ctrl, Alt, Cmd or Option), or a function key.'; assign.disabled = true; return; }
      // AltGr and Option keys that type a character keep typing it, so they cannot be a shortcut.
      if (typesCharacter(e)) { capture.value = displayChord(chord); hint.textContent = `These keys type ${e.key}. Choose another shortcut.`; pending = null; assign.disabled = true; return; }
      pending = chord; capture.value = displayChord(chord); assign.disabled = false;
      const owner = keymap.commandFor(chord);
      const builtIn = all.find(entry => entry.shortcut && entry.shortcut.toLowerCase() === displayChord(chord).toLowerCase());
      hint.textContent = owner && owner !== chosen.id ? `Currently assigned to ${all.find(x => x.id === owner)?.label || 'another command'}; assigning moves it here.`
        : builtIn && builtIn.id !== chosen.id ? `Built in for ${builtIn.label}. Your shortcut will take its place in the document.` : 'Available.';
    });
    detail.replaceChildren(
      el('h3.kb-title', {}, chosen.label), el('p.kb-path', {}, chosen.path.filter(Boolean).join(' › ')),
      el('div.kb-current', {},
        el('span.field-label', {}, 'Current shortcuts'),
        !custom.length && !(chosen.shortcut && !keymap.isCustom(chosen.id)) ? el('p.field-hint', {}, 'None') : null,
        ...(chosen.shortcut && !keymap.isCustom(chosen.id) && !custom.map(c => displayChord(c)).includes(chosen.shortcut) ? [el('div.kb-chord', {}, el('span.kbd', {}, chosen.shortcut), el('span.field-hint', {}, 'built in'))] : []),
        ...custom.map(chord => el('div.kb-chord', {}, el('span.kbd', {}, displayChord(chord)),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { keymap.remove(chosen.id, chord); renderList(); renderDetail(); } }, 'Remove')))),
      el('label.field', {}, el('span.field-label', {}, 'New shortcut'), capture), hint,
      el('div.row', {}, assign,
        el('button.btn.btn-ghost', { type: 'button', disabled: !keymap.isCustom(chosen.id), onclick: () => { keymap.reset(chosen.id); renderList(); renderDetail(); } }, 'Reset')));
  }
  const resetAll = el('button.btn.btn-ghost', { type: 'button', onclick: () => { keymap.reset(); renderList(); renderDetail(); } }, 'Reset All');
  const modal = openModal({ title: 'Customize Keyboard', wide: true, onClose, content: el('div.kb-dialog', {},
    el('div.kb-browse', {}, el('div.kb-filters', {}, category, filter), list),
    detail,
    el('div.row.row-end.kb-actions', {}, resetAll, el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Done'))) });
  modal.panel.classList.add('kb-panel');
  renderList(); renderDetail();
  filter.focus();
  return modal;
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
    .sort((a, b) => (a.path[0] || '').localeCompare(b.path[0] || '') || a.label.localeCompare(b.label));
}
