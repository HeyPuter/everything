import './badge.css';
import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';

/**
 * Unread activity count for a trip tab (feed entries by others after the read marker). Append `element` inside the tab
 * link; it hides itself at zero. Call `destroy()` when the space closes.
 */
export function unreadBadge(space, { max = 99, delay = 250 } = {}) {
  const count = el('span', { 'aria-hidden': 'true' });
  const label = el('span.sr-only');
  const element = el('span.collab-badge', { hidden: true }, count, label);
  let alive = true;
  let ticket = 0;
  let timer;

  async function refresh() {
    const current = ++ticket;
    let value;
    try { value = await space.unread(); } catch { return; }
    if (!alive || current !== ticket || !Number.isSafeInteger(value)) return;
    const locale = displayLocale();
    const format = new Intl.NumberFormat(locale);
    element.hidden = value <= 0;
    count.textContent = value > max ? `${format.format(max)}+` : format.format(value);
    label.textContent = t(new Intl.PluralRules(locale).select(value) === 'one' ? 'collab.unreadOne' : 'collab.unread', { count: format.format(value) });
  }
  // Feed growth and read-marker changes (presence events) are the only things that move the count.
  const off = space.subscribe((event) => {
    if (!event.feed && !event.types.has('presence')) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), delay);
  });
  void refresh();
  return {
    element,
    refresh,
    destroy() { alive = false; clearTimeout(timer); off(); element.remove(); },
  };
}
