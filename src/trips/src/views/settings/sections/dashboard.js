import { el, uid } from '../../../ui/dom.js';
import { icon } from '../icons.js';
import { button } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { makeSortable } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { prefs, setPrefs, onPrefs, currentDevice, DASHBOARD_WIDGETS } from '../../../lib/prefs.js';
import { group, statusLine } from '../ui.js';

const WIDGETS = {
  upcoming: { label: 'settings.widgetUpcoming', hint: 'settings.widgetUpcomingHint' },
  fx: { label: 'settings.widgetFx', hint: 'settings.widgetFxHint' },
  clocks: { label: 'settings.widgetClocks', hint: 'settings.widgetClocksHint' },
  collections: { label: 'settings.widgetCollections', hint: 'settings.widgetCollectionsHint' },
  atlas: { label: 'settings.widgetAtlas', hint: 'settings.widgetAtlasHint' },
};
const keyFor = (device) => (device === 'phone' ? 'widgetsPhone' : 'widgetsDesktop');

export function render(container, { signal }) {
  let device = currentDevice();
  let sortable = null;
  let last = '';
  let moving = false;
  const list = el('div.card.widget-list');
  const label = (value) => t(value === 'phone' ? 'settings.devicePhone' : 'settings.deviceDesktop');
  const chooser = segmented({ label: t('settings.deviceType'), value: device, onChange: (value) => { device = value; draw(); },
    items: ['desktop', 'phone'].map((value) => ({ value, label: value === currentDevice() ? t('settings.thisDevice', { device: label(value) }) : label(value) })) });
  [...chooser.element.children].forEach((node, index) => node.prepend(icon(index ? 'phone' : 'desktop', 16)));
  function save(change) {
    const current = prefs()[keyFor(device)];
    setPrefs({ [keyFor(device)]: change({ order: [...current.order], hidden: [...current.hidden] }) });
  }
  function draw() {
    sortable?.destroy();
    const entry = prefs()[keyFor(device)];
    last = JSON.stringify(entry);
    const known = entry.order.filter((id) => Object.hasOwn(WIDGETS, id) && DASHBOARD_WIDGETS.includes(id));
    list.replaceChildren(...known.map((id) => {
      const nameId = uid('widget'); const hintId = uid('widget-hint');
      const visible = !entry.hidden.includes(id);
      const toggle = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': visible, 'aria-labelledby': nameId, 'aria-describedby': hintId,
        onclick: () => save((value) => ({ ...value, hidden: visible ? [...value.hidden, id] : value.hidden.filter((item) => item !== id) })) }, el('span.switch-thumb'));
      return el('div.list-row.widget-row', { dataset: { sortableItem: '', widget: id, label: t(WIDGETS[id].label) } },
        el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', dataset: { sortableHandle: '' } }, icon('grip', 16)),
        el('span.widget-text', {}, el('span.pref-label', { id: nameId }, t(WIDGETS[id].label)), el('span.pref-hint', { id: hintId }, t(WIDGETS[id].hint))),
        toggle);
    }));
    // The list already shows the new order, so a move saves without redrawing (keeps the move announcement).
    sortable = makeSortable(list, { onMove: () => {
      const visibleOrder = [...list.querySelectorAll('[data-widget]')].map((node) => node.dataset.widget);
      moving = true;
      try { save((value) => ({ ...value, order: [...visibleOrder, ...value.order.filter((id) => !visibleOrder.includes(id))] })); } finally { moving = false; }
    } });
  }
  const reset = button(t('settings.widgetsReset'), { size: 'sm', variant: 'outline', onclick: () => setPrefs({ [keyFor(device)]: { order: [...DASHBOARD_WIDGETS], hidden: [] } }) });
  draw();
  const off = onPrefs((value) => {
    const next = JSON.stringify(value[keyFor(device)]);
    if (next === last) return;
    last = next;
    if (moving) return;
    // Keep keyboard focus on the same widget control after a redraw.
    const focused = document.activeElement; const row = focused?.closest?.('[data-widget]');
    const widget = row?.dataset.widget; const grip = focused?.matches?.('[data-sortable-handle]');
    draw();
    if (widget) list.querySelector(`[data-widget="${widget}"] ${grip ? '[data-sortable-handle]' : '[role=switch]'}`)?.focus();
  });
  signal?.addEventListener('abort', () => { off(); sortable?.destroy(); }, { once: true });
  container.replaceChildren(el('div.settings-stack', {},
    group(null, el('p.pref-hint', {}, t('settings.widgetsHint')), chooser.element, list, el('div.settings-actions', {}, reset)),
    statusLine(signal)));
}
