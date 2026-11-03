import { el, append, clear } from '../../../../ui/dom.js';
import { button, spinner } from '../../../../ui/bits.js';
import { field } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatTime } from '../../../../lib/format.js';
import { schedulePatches } from '../../../../lib/schedule/index.js';
import { dayLabel } from '../forms.js';
import { wallText, warningText } from './render.js';

function rangeText(item) {
  if (item.openStart) return wallText(item.endWall);
  if (item.openEnd || !item.endWall) return wallText(item.startWall);
  return t('schedule.range', { start: wallText(item.startWall), end: wallText(item.endWall) });
}

function previewRow(item, patch, nameOf) {
  let note;
  if (item.kind === 'res') note = t('schedule.booking');
  else if (!item.flexible) note = t('schedule.fixed');
  else if (patch) note = item.entity.start ? t('schedule.was', { time: formatTime(item.entity.start) }) : t('schedule.wasNone');
  else note = item.startWall?.offset !== 0 ? t('schedule.doesNotFit') : t('schedule.unchanged');
  return el(patch ? 'li.sched-preview-item.is-changed' : 'li.sched-preview-item', {},
    el('span.sched-preview-name', {}, nameOf(item.key)),
    el('span.sched-preview-time.num', {}, rangeText(item)),
    el('span.sched-preview-note', {}, note),
    item.warnings.map((warning) => el('span.sched-preview-warn', {}, warningText(warning, nameOf))));
}

/**
 * Auto schedule for one day: a start time, the proposed times (recomputed as the start changes and once travel
 * times and opening hours arrive) and Apply. Resolves true when the times were applied.
 */
export function openAutoSchedule({ dayId, entryOf, compute, prepare, start, saveStart, apply, nameOf }) {
  return new Promise((resolve) => {
    const entry = entryOf(dayId);
    if (!entry) { resolve(false); return; }
    let applied = false;
    let preparing = true;
    let closed = false;
    let patches = [];
    const startField = field({ label: t('schedule.startAt'), type: 'time', value: start, required: true });
    const from = el('p.field-hint', { hidden: true });
    const status = el('p.sched-status', { role: 'status' });
    const list = el('ol.sched-preview', { 'aria-label': t('schedule.preview') });
    const error = el('p.plan-form-error', { role: 'alert', hidden: true });
    const save = button(t('schedule.apply'), { type: 'submit', variant: 'primary', disabled: true });
    const form = el('form.plan-form', {}, el('p.field-hint', {}, t('schedule.intro')), startField.element, from, status, list, error,
      el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));

    function render() {
      const current = entryOf(dayId);
      if (!current) { dialog.close('gone'); return; }
      const day = compute(current, { auto: true, start: startField.input.value || start });
      const names = nameOf(current);
      patches = schedulePatches(day);
      const byId = new Map(patches.map((patch) => [patch.id, patch]));
      from.hidden = !day.leave;
      from.textContent = day.leave ? t('schedule.from', { name: day.leave.res.title }) : '';
      const rows = day.items.filter((item) => item.startWall || item.endWall).map((item) => previewRow(item, item.kind === 'visit' ? byId.get(item.id) : null, names));
      list.replaceChildren(...(rows.length ? rows : [el('li.sched-preview-empty', {}, t('schedule.noVisits'))]));
      const message = preparing ? t('schedule.routing') : !patches.length ? t('schedule.noChanges') : day.estimated ? t('schedule.estimated') : '';
      append(clear(status), [...(preparing ? [spinner()] : []), message && el('span', {}, message)]);
      save.disabled = !patches.length;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!patches.length || !form.reportValidity()) return;
      save.setAttribute('aria-busy', 'true');
      try {
        await apply(patches);
        applied = true;
        saveStart(startField.input.value);
        dialog.close('apply');
      } catch {
        error.textContent = t('schedule.saveFailed'); error.hidden = false;
      } finally { save.setAttribute('aria-busy', 'false'); }
    });
    startField.input.addEventListener('input', () => render());
    const dialog = openModal({
      title: t('schedule.autoTitle', { day: dayLabel(entry) }), content: form, wide: true, initialFocus: startField.input,
      onClose: () => { closed = true; resolve(applied); },
    });
    render();
    Promise.resolve(prepare(dayId)).catch(() => {}).finally(() => { preparing = false; if (!closed) render(); });
  });
}
