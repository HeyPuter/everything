import { el, uid } from './dom.js';
import { icon } from './icons.js';

export function tabs({ label, items, value = items[0]?.id, onChange }) {
  const element = el('div.tab-set');
  const list = el('div.tabs', { role: 'tablist', 'aria-label': label });
  const nodes = [];
  const panels = [];
  if (!items.some((item) => item.id === value && !item.disabled)) value = items.find((item) => !item.disabled)?.id;
  function select(id, notify = true) {
    if (!items.some((item) => item.id === id && !item.disabled)) return;
    value = id;
    items.forEach((item, index) => {
      const selected = item.id === value;
      nodes[index].setAttribute('aria-selected', String(selected));
      nodes[index].tabIndex = selected ? 0 : -1;
      panels[index].hidden = !selected;
    });
    if (notify) onChange?.(id);
  }
  items.forEach((item) => {
    const tabId = uid('tab'); const panelId = uid('tabpanel');
    const node = el('button.tab', { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId,
      disabled: item.disabled, onclick: () => select(item.id) }, item.icon && icon(item.icon, 16), el('span', {}, item.label));
    nodes.push(node); list.append(node);
    panels.push(el('section.tab-panel', { id: panelId, role: 'tabpanel', 'aria-labelledby': tabId, tabIndex: 0 }, item.content));
    node.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const enabled = nodes.filter((entry) => !entry.disabled);
      const rtl = getComputedStyle(list).direction === 'rtl';
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (enabled.indexOf(node) + delta + enabled.length) % enabled.length;
      const target = enabled[index]; target.focus(); select(items[nodes.indexOf(target)].id);
    });
  });
  element.append(list, ...panels); select(value, false);
  return { element, select, get value() { return value; } };
}
