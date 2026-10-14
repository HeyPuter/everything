/**
 * Line numbers: numbering the lines of a section in its margin (w:lnNumType) and suppressing them per paragraph.
 * Every change goes through the editor's transactions, so undo, saving and read-only rules apply.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { recallUnit } from '../lib/units.js';
import { checkedLineNumbers } from '../engine/line-number-settings.js';

const RESTARTS = [['newPage', 'Restart each page'], ['newSection', 'Restart each section'], ['continuous', 'Continuous']];
const TWIPS = { in: 1440, cm: 1440 / 2.54 };

/**
 * The Line Numbering Options dialog. `current` is the section's lineNumbers (or null);
 * `apply(value)` receives the new setting (null for none) and returns false when it cannot apply.
 */
export function openLineNumberOptions(current, apply, { unit = recallUnit(), onClose } = {}) {
  const value = current || { countBy: 1, start: 0, distance: null, restart: 'newPage' };
  const enabled = el('input', { type: 'checkbox', checked: !!current });
  const start = el('input.input', { type: 'number', min: 1, max: 32767, step: 1, required: true, value: value.start + 1, 'aria-label': 'Start at' });
  const automatic = el('input', { type: 'checkbox', checked: value.distance === null });
  const scale = TWIPS[unit] || TWIPS.in;
  const distance = el('input.input', { type: 'number', min: 0, max: unit === 'cm' ? 55.88 : 22, step: 'any', required: true,
    value: String(+((value.distance ?? 360) / scale).toFixed(unit === 'cm' ? 2 : 3)), 'aria-label': `From text (${unit})` });
  const countBy = el('input.input', { type: 'number', min: 1, max: 100, step: 1, required: true, value: value.countBy, 'aria-label': 'Count by' });
  const restarts = RESTARTS.map(([id, label]) => {
    const input = el('input', { type: 'radio', name: 'line-number-restart', value: id, checked: value.restart === id });
    return { id, input, node: el('label.ed-check', {}, input, label) };
  });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const fields = el('fieldset.ed-line-number-fields', {},
    el('legend.visually-hidden', {}, 'Line numbering'),
    el('label.field', {}, el('span.field-label', {}, 'Start at'), start),
    el('div.field', {}, el('span.field-label', {}, `From text (${unit})`), el('div.ed-line-number-distance', {}, el('label.ed-check', {}, automatic, 'Auto'), distance)),
    el('label.field', {}, el('span.field-label', {}, 'Count by'), countBy),
    el('fieldset.ed-line-number-restart', {}, el('legend.field-label', {}, 'Numbering'), ...restarts.map(r => r.node)));
  const refresh = () => { fields.disabled = !enabled.checked; distance.disabled = !enabled.checked || automatic.checked; };
  enabled.addEventListener('change', refresh); automatic.addEventListener('change', refresh); refresh();
  const content = el('form.ed-line-numbers', { onsubmit: e => {
    e.preventDefault();
    try {
      for (const input of [start, countBy, ...(distance.disabled ? [] : [distance])]) if (enabled.checked && !input.checkValidity()) { input.reportValidity(); return; }
      const next = !enabled.checked ? null : checkedLineNumbers({
        countBy: Number(countBy.value), start: Number(start.value) - 1,
        distance: automatic.checked ? null : Math.round(Number(distance.value) * scale),
        restart: restarts.find(r => r.input.checked)?.id || 'newPage',
      });
      if (apply(next) === false) throw new Error('These line numbering settings could not be applied.');
      modal.close();
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  } },
  el('label.ed-check', {}, enabled, 'Add line numbering'), fields,
  el('p.field-hint', {}, 'Numbers appear in the margin beside body text. Tables, headers, footers, footnotes and text boxes are not numbered. Applies to the section containing the cursor.'),
  error,
  el('div.row.row-end', {},
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
    el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Line Numbers', content, onClose: () => {
    const root = modal.panel.closest('.modal-root'); root?.setAttribute('inert', ''); root?.setAttribute('aria-hidden', 'true'); onClose?.();
  } });
  enabled.focus();
  return modal;
}

export function createLineNumbers({ editor, pkg, error, onChange = () => {}, commands: base = {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  let modal = null;
  /** The line numbering of the section holding the cursor. */
  const current = () => editor()?.model.sectionPageSettings?.lineNumbers ?? null;
  const commands = {
    lineNumbering: current,
    /**
     * Set the line numbering (null for none). scope 'section' is the section holding the
     * cursor; 'document' every section. A section-aware page-settings command, when the
     * Layout tab provides one, carries the scope; otherwise the whole document changes.
     */
    setLineNumbers(lineNumbers, { scope = 'section' } = {}) {
      const engine = ready(); if (!engine) return false;
      engine.finishComposition();
      let ok = false;
      try {
        const value = checkedLineNumbers(lineNumbers);
        ok = base.applySectionSettings ? base.applySectionSettings({ lineNumbers: value }, { scope }) : engine.setPageSettings({ lineNumbers: value });
      } catch (e) { error(e); return false; }
      engine.focus(); onChange();
      return ok;
    },
    toggleSuppressLineNumbers() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      engine.setParagraphFormat({ suppressLineNumbers: engine.model.paragraphFormatting.suppressLineNumbers !== true });
      onChange();
    },
    lineNumberItems() {
      const engine = editor(), editable = !!ready(), value = current();
      const choose = restart => commands.setLineNumbers(restart ? { ...(value || { countBy: 1, start: 0, distance: null }), restart } : null);
      const suppressed = engine?.model.paragraphFormatting.suppressLineNumbers;
      return [
        { label: 'None', radio: true, checked: !value, disabled: !editable, onSelect: () => choose(null) },
        { label: 'Continuous', radio: true, checked: value?.restart === 'continuous', disabled: !editable, onSelect: () => choose('continuous') },
        { label: 'Restart Each Page', radio: true, checked: value?.restart === 'newPage', disabled: !editable, onSelect: () => choose('newPage') },
        { label: 'Restart Each Section', radio: true, checked: value?.restart === 'newSection', disabled: !editable, onSelect: () => choose('newSection') },
        { separator: true },
        { label: 'Suppress for Current Paragraph', checked: suppressed === true, disabled: !editable, onSelect: () => commands.toggleSuppressLineNumbers() },
        { separator: true },
        { label: 'Line Numbering Options…', icon: 'lineNumbers', disabled: !editable, onSelect: () => commands.lineNumberOptions() },
      ];
    },
    lineNumberOptions() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      modal = openLineNumberOptions(current(), value => commands.setLineNumbers(value), { onClose: () => queueMicrotask(() => editor()?.focus()) });
    },
  };
  /** Ribbon groups for a tab: the Layout tab's Page Setup group shows lineNumberItems itself. */
  function extendTab() { return []; }
  /** Items for the menu bar's menus. */
  function extendMenu(menuId) {
    if (menuId !== 'format') return [];
    return [{ label: 'Line Numbers', icon: 'lineNumbers', items: commands.lineNumberItems() }];
  }
  /** Items appended to the document context menu. */
  function contextMenuItems(context) {
    const engine = editor();
    if (context !== 'text' || !engine || engine.session.path !== null || !engine.model.sectionPageSettings?.lineNumbers) return [];
    return [{ label: 'Suppress Line Numbers', checked: engine.model.paragraphFormatting.suppressLineNumbers === true, disabled: !ready(), onSelect: () => commands.toggleSuppressLineNumbers() }];
  }
  return { commands, extendTab, extendMenu, contextMenuItems, destroy() { modal?.close(); } };
}
