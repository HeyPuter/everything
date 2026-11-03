import { el } from '../../../../ui/dom.js';
import { checkbox, field } from '../../../../ui/fields.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDuration } from '../../../../lib/format.js';
import { defaultDwell, MAX_DWELL } from '../../../../lib/schedule/index.js';
import { categoryOf } from '../../../../lib/categories.js';

/** Dwell and "fixed time" fields for the visit form: `{nodes, read() → {set, unset}}`. */
export function visitFields(space, visit) {
  const spot = visit.placeId ? space.get('place', visit.placeId) : null;
  const fallback = defaultDwell(spot);
  const duration = formatDuration(fallback);
  const dwell = field({
    label: t('schedule.dwellLabel'), type: 'number', value: visit.dwell ?? '', min: 0, max: MAX_DWELL, step: 5, inputMode: 'numeric', placeholder: String(fallback),
    hint: spot ? t('schedule.dwellHint', { category: categoryOf(space, spot.cat).name, duration }) : t('schedule.dwellHintItem', { duration }),
  });
  const pinned = checkbox(t('schedule.pinned'), { checked: visit.pinned === true });
  const node = el('fieldset.sched-fields', {}, el('legend.field-label', {}, t('schedule.fields')), dwell.element, pinned, el('p.field-hint', {}, t('schedule.pinnedHint')));
  return {
    nodes: [node],
    read() {
      const set = {};
      const unset = [];
      const raw = dwell.input.value.trim();
      const value = Math.round(Number(raw));
      if (!raw) { if (visit.dwell !== undefined) unset.push('dwell'); }
      else if (Number.isInteger(value) && value >= 0 && value <= MAX_DWELL && value !== visit.dwell) set.dwell = value;
      const fixed = pinned.querySelector('input').checked;
      if (fixed && visit.pinned !== true) set.pinned = true;
      if (!fixed && visit.pinned !== undefined) unset.push('pinned');
      return { set, unset };
    },
  };
}
