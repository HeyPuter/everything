import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { checkbox, field, segmented } from '../../ui/fields.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate } from '../../lib/format.js';
import { SECTIONS } from './options.js';

const dayLabel = (day, index) => [t('plan.dayNumber', { number: index + 1 }), day.date ? formatDate(day.date, { weekday: true, year: false }) : day.title].filter(Boolean).join(' · ');

function labelledGroup(label, control, hint) {
  const id = uid('print-label');
  control.element.removeAttribute('aria-label');
  control.element.setAttribute('aria-labelledby', id);
  return el('div.print-field', {}, el('span.field-label', { id }, label), control.element, hint && el('p.field-hint', {}, hint));
}

/**
 * The options panel. `onChange(options)` gets a fresh copy on every change; `update({options, days, available})`
 * follows the trip (days added or removed elsewhere) without stealing focus.
 */
export function optionsForm({ options, days, available, onChange }) {
  let state = { ...options, sections: [...options.sections] };
  let dayList = days;
  const emit = () => onChange({ ...state, sections: [...state.sections] });

  const boxes = new Map(SECTIONS.map((id) => [id, checkbox(t(`print.section.${id}`), {
    checked: state.sections.includes(id),
    onChange: (on) => { state.sections = SECTIONS.filter((section) => (section === id ? on : state.sections.includes(section))); emit(); },
  })]));
  const sections = el('fieldset.print-fieldset', {}, el('legend', {}, t('print.sections')), [...boxes.values()]);

  const from = field({ label: t('print.fromDay'), type: 'select' });
  const to = field({ label: t('print.toDay'), type: 'select' });
  const index = (id) => dayList.findIndex((day) => day.id === id);
  from.input.addEventListener('change', () => {
    state.from = from.input.value;
    if (index(state.to) < index(state.from)) { state.to = state.from; to.input.value = state.to; }
    emit();
  });
  to.input.addEventListener('change', () => {
    state.to = to.input.value;
    if (index(state.from) > index(state.to)) { state.from = state.to; from.input.value = state.from; }
    emit();
  });
  const range = el('fieldset.print-fieldset', {}, el('legend', {}, t('print.dayRange')),
    el('div.print-range', {}, from.element, to.element), el('p.field-hint', {}, t('print.dayRangeHint')));
  const all = button(t('print.allDays'), { size: 'sm', variant: 'ghost', onclick: () => {
    state.from = dayList[0]?.id ?? null; state.to = dayList.at(-1)?.id ?? null;
    from.input.value = state.from ?? ''; to.input.value = state.to ?? ''; emit();
  } });
  range.append(all);

  const detail = segmented({
    label: t('print.detail'), value: state.detail,
    items: [{ value: 'compact', label: t('print.compact') }, { value: 'detailed', label: t('print.detailed') }],
    onChange: (value) => { state.detail = value; emit(); },
  });
  const orientation = segmented({
    label: t('print.orientation'), value: state.orientation,
    items: [{ value: 'portrait', label: t('print.portrait') }, { value: 'landscape', label: t('print.landscape') }],
    onChange: (value) => { state.orientation = value; emit(); },
  });
  const font = segmented({
    label: t('print.textSize'), value: state.font,
    items: [{ value: 'small', label: t('print.small') }, { value: 'medium', label: t('print.medium') }, { value: 'large', label: t('print.large') }],
    onChange: (value) => { state.font = value; emit(); },
  });
  const pageBreak = checkbox(t('print.pageBreak'), { checked: state.pageBreak, onChange: (on) => { state.pageBreak = on; emit(); } });
  const photos = checkbox(t('print.photos'), { checked: state.photos, onChange: (on) => { state.photos = on; emit(); } });
  const compress = checkbox(t('print.compress'), { checked: state.compress, onChange: (on) => { state.compress = on; emit(); } });

  const layout = el('fieldset.print-fieldset', {}, el('legend', {}, t('print.layout')),
    labelledGroup(t('print.detail'), detail, t('print.detailHint')), labelledGroup(t('print.orientation'), orientation),
    labelledGroup(t('print.textSize'), font), pageBreak);
  const images = el('fieldset.print-fieldset', {}, el('legend', {}, t('print.images')), photos, compress, el('p.field-hint', {}, t('print.imagesHint')));
  const element = el('form.print-options', { 'aria-label': t('print.options'), onsubmit: (event) => event.preventDefault() }, sections, range, layout, images);

  function update(next) {
    state = { ...next.options, sections: [...next.options.sections] };
    for (const [id, node] of boxes) {
      node.hidden = !next.available.includes(id);
      node.querySelector('input').checked = state.sections.includes(id);
    }
    if (next.days !== dayList || from.input.options.length !== next.days.length) {
      dayList = next.days;
      const choices = () => dayList.map((day, position) => el('option', { value: day.id }, dayLabel(day, position)));
      from.input.replaceChildren(...choices());
      to.input.replaceChildren(...choices());
    }
    from.input.value = state.from ?? '';
    to.input.value = state.to ?? '';
    range.hidden = dayList.length < 2;
    detail.setValue(state.detail); orientation.setValue(state.orientation); font.setValue(state.font);
    pageBreak.querySelector('input').checked = state.pageBreak;
    photos.querySelector('input').checked = state.photos;
    photos.querySelector('input').disabled = state.detail === 'compact';
    compress.querySelector('input').checked = state.compress;
  }
  update({ options, days, available });
  return { element, update };
}
