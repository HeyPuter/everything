import { el } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { field } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { t } from '../../../../lib/i18n/index.js';
import { countryName } from './view.js';

/** Region per country for regional and school holidays. Choices come from the provider, else from the holiday data. */
export function openRegionDialog({ store, countries }) {
  const fields = [];
  const hint = el('p.field-hint', {}, t('weather.regionsHint'));
  const body = el('div.wx-regions', {}, hint, el('p.wx-status', { role: 'status' }, t('weather.regionsLoading')));
  const save = button(t('ui.save'), { variant: 'primary', disabled: true, onclick: () => {
    store.setRegions(Object.fromEntries(fields.map(([cc, item]) => [cc, item.input.value || null])));
    dialog.close();
  } });
  const dialog = openModal({ title: t('weather.regionsTitle'), content: body, actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save] });
  let open = true;
  void dialog.closed.then(() => { open = false; });
  void store.regionChoices(countries).then((choices) => {
    if (!open) return;
    body.replaceChildren(hint, ...choices.map((choice) => {
      if (!choice.options.length) return el('p', {}, t('weather.regionsNone', { country: countryName(choice.cc) }));
      const item = field({
        label: countryName(choice.cc), type: 'select', value: choice.code ?? '',
        options: [{ value: '', label: t('weather.allRegions') }, ...choice.options.map((option) => ({ value: option.code, label: option.name }))],
      });
      fields.push([choice.cc, item]);
      return item.element;
    }));
    save.disabled = !fields.length;
    fields[0]?.[1].input.focus();
  }, () => { if (open) body.replaceChildren(hint, el('p.wx-status', { role: 'alert' }, t('weather.holidaysUnavailable'))); });
  return dialog;
}
