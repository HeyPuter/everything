import { el, fieldId } from '../ui/dom.js';
import { TAB_LEADERS } from '../engine/tab-leaders.js';
import { normalizeTabStops, sameValue } from '../engine/paragraph-geometry.js';
import { field, group, distance, openFormatDialog, UNITS } from './format-dialog-kit.js';

export const TAB_KINDS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['decimal', 'Decimal'], ['bar', 'Bar']];
const LEADERS = Object.entries(TAB_LEADERS).filter(([value]) => value !== 'heavy');

/**
 * The Tabs dialog: the selection's custom stops in a list, the default stop interval, and Set, Clear and
 * Clear All. Stops apply to every selected paragraph in one undo step; the default interval is a
 * document setting (w:defaultTabStop). Positions are measured from the text margin.
 */
export function openTabsDialog({ tabs: initial, defaultTabStop, unit = 'in', apply, onClose }) {
  const u = UNITS[unit] || UNITS.in;
  let stops = (initial || []).map(t => ({ ...t, leader: t.leader || 'none' }));
  const cleared = [];
  let changed = false;
  const format = twips => `${Number((twips / u.twips).toFixed(u.digits))} ${u.label}`;
  const position = el('input.input', { type: 'text', inputMode: 'decimal', 'aria-label': `Tab stop position (${u.label})`, autocomplete: 'off', placeholder: `e.g. 1.5` });
  const list = el('div.fmt-listbox', { role: 'listbox', 'aria-label': 'Tab stops', tabindex: 0 });
  const interval = distance('Default tab stops', defaultTabStop, { unit, min: 1 / 1440, required: true });
  const name = fieldId('fmt-tab-kind'), leaderName = fieldId('fmt-tab-leader');
  const radios = (groupName, choices, value) => choices.map(([v, label]) => el('label.ed-check', {}, el('input', { type: 'radio', name: groupName, value: v, checked: v === value }), label));
  const kinds = radios(name, TAB_KINDS, 'left'), leaders = radios(leaderName, LEADERS, 'none');
  const chosen = nodes => nodes.map(n => n.firstChild).find(r => r.checked)?.value;
  const choose = (nodes, value) => { for (const n of nodes) n.firstChild.checked = n.firstChild.value === value; };
  const clearedNote = el('p.field-hint', { 'aria-live': 'polite' });
  const mixedNote = el('p.field-hint', { hidden: initial !== null }, 'Tab stops differ across the selection. Setting or clearing stops replaces them for every selected paragraph.');

  // A typed unit counts ("2.54 cm" in an inch dialog is one inch); without one, the dialog's unit applies.
  const UNIT_TWIPS = { in: 1440, '″': 1440, '"': 1440, cm: 1440 / 2.54, mm: 144 / 2.54, pt: 20 };
  const readPosition = () => {
    const typed = /\s*(in|cm|mm|pt|″|")$/i.exec(position.value.trim());
    const raw = position.value.trim().slice(0, typed ? -typed[0].length : undefined).replace(',', '.');
    const number = Number(raw);
    if (!raw || !Number.isFinite(number)) throw new Error('Enter a tab stop position.');
    const twips = Math.round(number * (typed ? UNIT_TWIPS[typed[1].toLowerCase()] : u.twips));
    if (Math.abs(twips) > 31680) throw new Error('Tab positions must be within 22 inches of the margin.');
    return twips;
  };
  function render(selected = null) {
    list.replaceChildren(...stops.map((stop, i) => {
      const item = el('div.fmt-listbox-item', { role: 'option', id: fieldId('fmt-tab-stop'), 'aria-selected': String(stop.position === selected), dataset: { index: i },
        onclick: () => pick(i) }, format(stop.position), el('span.fmt-listbox-meta', {}, `${TAB_KINDS.find(([k]) => k === stop.alignment)?.[1] || stop.alignment}${stop.leader && stop.leader !== 'none' ? ` · ${TAB_LEADERS[stop.leader]}` : ''}`));
      return item;
    }));
    if (!stops.length) list.append(el('div.fmt-listbox-empty', {}, 'No custom tab stops'));
    const active = list.querySelector('[aria-selected="true"]');
    if (active) list.setAttribute('aria-activedescendant', active.id); else list.removeAttribute('aria-activedescendant');
    clearedNote.textContent = cleared.length ? `Tab stops to be cleared: ${cleared.map(format).join(', ')}` : '';
  }
  function pick(i) {
    const stop = stops[i]; if (!stop) return;
    position.value = String(Number((stop.position / u.twips).toFixed(u.digits)));
    choose(kinds, stop.alignment); choose(leaders, stop.leader || 'none');
    render(stop.position);
  }
  list.addEventListener('keydown', e => {
    const current = Number(list.querySelector('[aria-selected="true"]')?.dataset.index ?? -1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(0, Math.min(stops.length - 1, (current < 0 ? -1 : current) + (e.key === 'ArrowDown' ? 1 : -1)))); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clear(); }
  });
  function set() {
    const at = readPosition();
    const stop = { position: at, alignment: chosen(kinds), leader: chosen(leaders) };
    const next = [...stops.filter(s => s.position !== at), stop];
    normalizeTabStops(next.map(s => ({ ...s, leader: s.leader === 'none' ? undefined : s.leader })));
    stops = next.sort((a, b) => a.position - b.position);
    const index = cleared.indexOf(at); if (index >= 0) cleared.splice(index, 1);
    changed = true; render(at); position.focus(); position.select();
  }
  function clear() {
    let at; try { at = readPosition(); } catch { return; }
    if (!stops.some(s => s.position === at)) { modal.fail(`There is no tab stop at ${format(at)}.`); return; }
    stops = stops.filter(s => s.position !== at); cleared.push(at); changed = true;
    if (stops[0]) pick(0); else { position.value = ''; render(); }
  }
  const setButton = el('button.btn.btn-outline', { type: 'button', onclick: () => { try { set(); modal.form.querySelector('.field-error').hidden = true; } catch (e) { modal.fail(e.message); } } }, 'Set');
  const clearButton = el('button.btn.btn-outline', { type: 'button', onclick: clear }, 'Clear');
  const clearAll = el('button.btn.btn-outline', { type: 'button', onclick: () => { cleared.push(...stops.map(s => s.position)); stops = []; changed = true; render(); } }, 'Clear All');
  position.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); setButton.click(); } });
  render();
  if (stops[0]) pick(0);

  const body = el('div.fmt-tabs-layout', {},
    el('div.fmt-tabs-stops', {}, field(`Tab stop position (${u.label})`, position), list, mixedNote),
    el('div.fmt-tabs-options', {},
      field(`Default tab stops (${u.label})`, interval),
      group('Alignment', el('div.fmt-radios', { role: 'radiogroup', 'aria-label': 'Alignment' }, ...kinds)),
      group('Leader', el('div.fmt-radios', { role: 'radiogroup', 'aria-label': 'Leader' }, ...leaders)),
      el('div.row', {}, setButton, clearButton, clearAll)),
  );
  const modal = openFormatDialog({ title: 'Tabs', className: 'fmt-tabs-dialog', onClose, body: [body, clearedNote],
    submit: () => {
      // Pending text in the position field is set, as the dialog's OK does on desktop word processors.
      if (position.value.trim() && !stops.some(s => { try { return s.position === readPosition(); } catch { return false; } })) set();
      const tabs = changed ? normalizeTabStops(stops.map(s => ({ position: s.position, alignment: s.alignment, ...(s.leader !== 'none' ? { leader: s.leader } : {}), ...(s.numberingOnly ? { numberingOnly: true } : {}) }))) : undefined;
      const interval_ = interval.read();
      if (!interval_ || interval_ < 1) throw new Error('Enter a default tab interval greater than zero.');
      if (tabs === undefined && interval_ === defaultTabStop) return true;
      if (tabs !== undefined && sameValue(tabs, initial) && interval_ === defaultTabStop) return true;
      return apply(tabs, interval_);
    } });
  position.focus();
  return modal;
}
