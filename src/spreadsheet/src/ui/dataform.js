/**
 * Data ▸ Form: one record of a list at a time, its fields down the left and the record's
 * place and the form's buttons on the right. Typing changes the record; moving to another
 * record (the arrows, the slider, Find, Enter) or closing writes it back as one undo step,
 * and Restore puts back what the record held. New starts a blank record that is added
 * under the list once something is typed in it. Criteria turns the fields into a search:
 * Find Prev and Find Next then step through the records that match.
 */
import { el, fieldId } from './dom.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import * as S from '../core/selection.js';
import { findList, recordCount, recordRow, readRecord, writeRecord, appendRecord, appendProblem, deleteRecord, findRecord, hasCriteria } from '../core/data-form.js';

const PAGE = 10;

/** Open the form over the list at the selection. Returns the form's handle, or null when there is no list there. */
export function openDataForm(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const active = ctx.active();
  let list = findList(wb, sheetId, active.r, active.c);
  if (!list || !list.fields.length) {
    toast('Select a cell in a list with a header row to open its form', { icon: 'alert', duration: 3500 });
    return null;
  }
  if (list.header == null) {
    toast('The form needs a header row to name its fields', { icon: 'alert', duration: 3500 });
    return null;
  }

  // Where the form is: a record (0-based), `count` for the new record, and whether the fields hold criteria.
  let index = Math.min(Math.max(0, active.r - list.first), Math.max(0, recordCount(list) - 1));
  if (!recordCount(list)) index = 0;
  let mode = recordCount(list) ? 'record' : 'new';
  let criteria = {};
  let shown = []; // the record's fields as read, to tell what was typed and to restore it

  const idBase = fieldId('dataform');
  const status = el('p.df-status', { id: `${idBase}-status`, role: 'status', 'aria-live': 'polite' });
  const message = el('p.df-message.small', { role: 'alert', hidden: true });
  const fieldsBox = el('div.df-fields', { role: 'group', 'aria-labelledby': `${idBase}-status` });
  const rows = list.fields.map((f, k) => {
    const id = `${idBase}-f${k}`;
    const input = el('input.input.df-input', { type: 'text', id, autocomplete: 'off', spellcheck: false, 'data-col': f.c });
    const readOnly = el('output.df-readonly', { id: `${id}-v`, 'aria-label': `${f.name} (calculated)` });
    const label = el('label.df-label', { for: id, title: f.name }, `${f.name}:`);
    input.addEventListener('input', () => { refreshButtons(); });
    input.addEventListener('keydown', onFieldKey);
    return { field: f, input, readOnly, label, row: el('div.df-row', {}, label, input, readOnly) };
  });
  fieldsBox.append(...rows.map((x) => x.row));

  const slider = el('input.df-slider', { type: 'range', min: 0, max: 0, step: 1, value: 0, 'aria-label': 'Record' });
  slider.addEventListener('input', () => go(Number(slider.value)));

  const btn = (label, onclick, extra = {}) => el('button.btn.btn-sm', { type: 'button', onclick, ...extra }, label);
  const newBtn = btn('New', () => startNew());
  const deleteBtn = btn('Delete', () => removeRecord());
  const restoreBtn = btn('Restore', () => restore());
  const prevBtn = btn('Find Prev', () => find(-1));
  const nextBtn = btn('Find Next', () => find(1));
  const criteriaBtn = btn('Criteria', () => toggleCriteria());
  const closeBtn = btn('Close', () => modal.close(), { className: 'btn btn-sm btn-primary' });

  const content = el('div.df-form', {},
    el('div.df-main', {}, fieldsBox, slider, message),
    el('div.df-side', {}, status, newBtn, deleteBtn, restoreBtn, el('div.df-gap'), prevBtn, nextBtn, criteriaBtn, el('div.df-gap'), closeBtn));

  const sheetName = wb.sheet(sheetId)?.name || 'Sheet';
  const modal = openModal({ title: `Form: ${sheetName}`, content, onClose: () => finish(), initialFocus: null });
  let closing = false;

  /** The text typed into each editable field, by column. */
  const typed = () => Object.fromEntries(rows.filter((x) => !x.input.hidden).map((x) => [x.field.c, x.input.value]));
  const dirty = () => {
    if (mode === 'criteria') return false;
    if (mode === 'new') return rows.some((x) => !x.input.hidden && x.input.value !== '');
    return rows.some((x, k) => !x.input.hidden && x.input.value !== (shown[k]?.text ?? ''));
  };

  function say(text) {
    message.hidden = !text;
    message.textContent = text || '';
  }

  /** Write what was typed into the record shown (or add the new record). False when it could not be written. */
  function commit() {
    if (!dirty()) return true;
    if (mode === 'new') {
      const problem = appendProblem(wb, list);
      if (problem) { say(problem); return false; }
      const grown = appendRecord(wb, list, typed());
      if (!grown) { say('The new record could not be added here (the sheet or the cells under the list may be protected)'); return false; }
      list = grown;
      index = recordCount(list) - 1;
      mode = 'record';
      return true;
    }
    const want = typed();
    const changed = rows.filter((x, k) => !shown[k]?.formula && want[x.field.c] !== shown[k]?.text).length;
    const written = writeRecord(wb, list, index, want);
    if (changed && !written) { say('The record could not be changed (the sheet or these cells may be protected)'); return false; }
    return true;
  }

  function render({ focus = true } = {}) {
    const n = recordCount(list);
    if (mode === 'record' && !n) mode = 'new';
    if (mode === 'record') index = Math.min(index, n - 1);
    shown = mode === 'record' ? readRecord(wb, list, index) : list.fields.map((f) => ({ c: f.c, name: f.name, formula: false, text: '', display: '' }));
    // In a new record the computed columns of the list are still formulas to come: they show as such.
    const lastRecord = n ? readRecord(wb, list, n - 1) : null;
    rows.forEach((x, k) => {
      const f = shown[k];
      const computed = mode === 'record' ? f.formula : mode === 'new' && !!lastRecord?.[k]?.formula;
      x.input.hidden = computed && mode !== 'criteria';
      x.readOnly.hidden = !x.input.hidden;
      x.readOnly.textContent = mode === 'record' ? f.display : '';
      x.input.value = mode === 'criteria' ? (criteria[x.field.c] ?? '') : f.text;
      x.input.setAttribute('aria-label', mode === 'criteria' ? `${x.field.name} criteria` : x.field.name);
    });
    status.textContent = mode === 'criteria' ? 'Criteria' : mode === 'new' ? 'New Record' : `${index + 1} of ${n}`;
    slider.max = String(n);
    slider.value = String(mode === 'new' ? n : index);
    slider.setAttribute('aria-valuetext', mode === 'new' ? 'New record' : `Record ${index + 1} of ${n}`);
    slider.disabled = mode === 'criteria';
    criteriaBtn.textContent = mode === 'criteria' ? 'Form' : 'Criteria';
    newBtn.textContent = mode === 'criteria' ? 'Clear' : 'New';
    content.classList.toggle('criteria', mode === 'criteria');
    refreshButtons();
    if (focus) (rows.find((x) => !x.input.hidden)?.input || closeBtn).focus({ preventScroll: true });
  }

  function refreshButtons() {
    const n = recordCount(list);
    deleteBtn.disabled = mode !== 'record' || !n;
    restoreBtn.disabled = mode === 'criteria' ? !hasCriteria(currentCriteria()) : !dirty();
    prevBtn.disabled = mode !== 'criteria' && (n === 0 || (mode === 'record' && index === 0 && !hasCriteria(criteria)));
    nextBtn.disabled = mode !== 'criteria' && n === 0;
  }

  const currentCriteria = () => (mode === 'criteria' ? Object.fromEntries(rows.map((x) => [x.field.c, x.input.value])) : criteria);

  /** Move to record `i` (`recordCount` is the new record), writing the record shown first. */
  function go(i) {
    say('');
    if (!commit()) { render({ focus: false }); return; }
    const n = recordCount(list);
    if (i >= n) { mode = 'new'; index = n; } else { mode = 'record'; index = Math.max(0, i); }
    render();
  }

  function startNew() {
    if (mode === 'criteria') { criteria = {}; rows.forEach((x) => { x.input.value = ''; }); refreshButtons(); rows[0]?.input.focus(); return; }
    // New on a new record that holds something adds it and starts another.
    say('');
    if (!commit()) { render({ focus: false }); return; }
    mode = 'new';
    index = recordCount(list);
    render();
  }

  async function removeRecord() {
    if (mode !== 'record') return;
    const ok = await confirmDialog({ title: 'Delete record?', message: 'The record shown will be deleted, and the records under it move up. You can undo this.', confirmLabel: 'Delete' });
    if (!ok || closing) return;
    const shorter = deleteRecord(wb, list, index);
    if (!shorter) { say('The record could not be deleted (the sheet may be protected, or a table or merged cell is in the way)'); return; }
    list = shorter;
    render();
  }

  function restore() {
    if (mode === 'criteria') { rows.forEach((x) => { x.input.value = criteria[x.field.c] ?? ''; }); refreshButtons(); return; }
    rows.forEach((x, k) => { x.input.value = shown[k]?.text ?? ''; });
    say('');
    refreshButtons();
  }

  function toggleCriteria() {
    say('');
    if (mode === 'criteria') { criteria = currentCriteria(); mode = recordCount(list) ? 'record' : 'new'; render(); return; }
    if (!commit()) { render({ focus: false }); return; }
    mode = 'criteria';
    render();
  }

  /** Find Prev / Find Next: the next record matching the criteria (every record when none are set). */
  function find(dir) {
    say('');
    if (mode === 'criteria') { criteria = currentCriteria(); mode = 'record'; index = dir > 0 ? -1 : recordCount(list); }
    else if (!commit()) { render({ focus: false }); return; }
    const from = mode === 'new' ? recordCount(list) : index;
    const hit = findRecord(wb, list, from, dir, criteria);
    if (hit < 0) {
      // Nothing further that way: the form stays where it is (on the first or last match it found before).
      if (index < 0 || index >= recordCount(list)) index = Math.max(0, Math.min(recordCount(list) - 1, findRecord(wb, list, dir > 0 ? recordCount(list) : -1, -dir, criteria)));
      mode = recordCount(list) ? 'record' : 'new';
      render({ focus: false });
      say(hasCriteria(criteria) ? 'No more records match the criteria in that direction' : '');
      return;
    }
    mode = 'record';
    index = hit;
    render();
  }

  function onFieldKey(e) {
    if (e.isComposing) return;
    const n = recordCount(list);
    const at = mode === 'new' ? n : index;
    const keep = () => { const col = Number(e.currentTarget.dataset.col); queueMicrotask(() => rows.find((x) => x.field.c === col && !x.input.hidden)?.input.focus()); };
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'criteria') { find(e.shiftKey ? -1 : 1); return; }
      go(e.shiftKey ? at - 1 : at + 1);
      return;
    }
    if (mode === 'criteria') return;
    let to = null;
    if (e.key === 'ArrowDown') to = at + 1;
    else if (e.key === 'ArrowUp') to = at - 1;
    else if (e.key === 'PageDown') to = Math.min(n, at + PAGE);
    else if (e.key === 'PageUp') to = at - PAGE;
    if (to == null) return;
    e.preventDefault();
    if (to < 0) to = 0;
    if (to === at) return;
    go(to);
    keep();
  }

  /** Closing writes the record shown and leaves the grid on it. */
  function finish() {
    closing = true;
    if (mode !== 'criteria') commit();
    const r = mode === 'record' ? recordRow(list, index) : null;
    if (r != null && ctx.grid?.setSelection && ctx.sheetId() === list.sheetId) ctx.grid.setSelection(S.single(r, list.c1), { scroll: true });
    ctx.grid?.focus?.();
  }

  render();
  return {
    get index() { return index; },
    get mode() { return mode; },
    get list() { return list; },
    close: () => modal.close(),
  };
}
