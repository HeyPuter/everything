import { el, fieldId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { segmented } from '../ui/segmented.js';

/**
 * Preferences: the settings that used to be spread over the account menu, the View tab and the
 * Review tab, in one dialog. Every control applies at once (there is no OK to forget), and each says
 * where it applies. Sections come from the editor: [{ id, label, controls: [control] }], where a control is
 *   { type: 'toggle', label, hint?, get(), set(value) }
 *   { type: 'choice', label, hint?, options: [[value, label]], get(), set(value) }
 *   { type: 'button', label, hint?, run() }
 */
export function openPreferences({ sections, section = null, onClose }) {
  const nav = el('div.pref-nav', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Preference sections' });
  const body = el('div.pref-body', { role: 'tabpanel', tabindex: -1 });
  const tabs = sections.map(s => el('button.pref-tab', { type: 'button', role: 'tab', id: `pref-tab-${s.id}`, 'aria-selected': 'false', tabIndex: -1, onclick: () => show(s.id) }, s.label));
  nav.append(...tabs);
  nav.addEventListener('keydown', e => {
    const at = tabs.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (at < 0 || next === null) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    show(tab.id.slice(9)); tab.focus();
  });
  function control(def) {
    const hint = def.hint ? el('span.pref-hint', {}, def.hint) : null;
    if (def.type === 'toggle') {
      const input = el('input', { type: 'checkbox', role: 'switch', checked: !!def.get(), disabled: !!def.disabled, onchange: () => { def.set(input.checked); input.checked = !!def.get(); } });
      return el('label.pref-row.pref-toggle', {}, el('span.pref-text', {}, el('span.pref-label', {}, def.label), hint), input, el('span.ed-switch', { 'aria-hidden': 'true' }));
    }
    if (def.type === 'choice' && def.options.length <= 3 && !def.select) {
      const id = fieldId('pref');
      return el('div.pref-row', {}, el('span.pref-text', { id }, el('span.pref-label', {}, def.label), hint),
        segmented(def.options, def.get(), value => def.set(value), def.label));
    }
    if (def.type === 'choice') {
      const select = el('select.input', { 'aria-label': def.label, onchange: () => def.set(select.value) }, ...def.options.map(([value, label]) => el('option', { value }, label)));
      select.value = def.get();
      return el('label.pref-row', {}, el('span.pref-text', {}, el('span.pref-label', {}, def.label), hint), select);
    }
    if (def.type === 'button') {
      return el('div.pref-row', {}, el('span.pref-text', {}, el('span.pref-label', {}, def.label), hint),
        el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => { def.run(); } }, def.action || 'Open…'));
    }
    return null;
  }
  function show(id) {
    const s = sections.find(x => x.id === id) || sections[0];
    tabs.forEach((tab, i) => { const on = sections[i] === s; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
    body.setAttribute('aria-labelledby', `pref-tab-${s.id}`);
    body.replaceChildren(el('h3.pref-heading', {}, s.label), ...(s.note ? [el('p.pref-note', {}, s.note)] : []), ...s.controls.filter(Boolean).map(control).filter(Boolean));
  }
  const modal = openModal({ title: 'Preferences', wide: true, onClose, content: el('div.pref-dialog', {}, nav, body) });
  modal.panel.classList.add('pref-panel');
  show(section || sections[0].id);
  tabs.find(t => t.getAttribute('aria-selected') === 'true')?.focus();
  return modal;
}
