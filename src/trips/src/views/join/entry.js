import './entry.css';
import { el } from '../../ui/dom.js';
import { t } from '../../lib/i18n/index.js';
import { icon } from '../trip/members/icons.js';

const count = (value) => new Intl.NumberFormat().format(value);

/**
 * Shell entry for the invitations inbox (named invites arrive as Puter KV shares). Create one per sign-in and place
 * `element` in the header on each render. `context()` returns the view context; the entry stays hidden until it carries
 * `session.invites`. The dialog loads on first use.
 */
export function createInboxEntry(context) {
  const listeners = new Set();
  let destroyed = false;
  let source = null;
  let stopWatch = null;
  let run = 0;
  let dialog = null;
  const badge = el('span.inbox-badge', { 'aria-hidden': 'true', hidden: true });
  const element = el('button.icon-btn.inbox-button', { type: 'button', hidden: true, onclick: () => void openDialog() }, icon('inbox'), badge);
  const model = {
    items: [], state: 'idle', error: null,
    refresh,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get invites() { return source; },
    get context() { return context(); },
  };
  const emit = () => { for (const listener of listeners) listener(model); };

  function label() {
    const total = model.items.length;
    const text = total ? t('join.inboxCount', { count: count(total) }) : t('join.inbox');
    element.setAttribute('aria-label', text);
    element.title = text;
    badge.textContent = total > 9 ? '9+' : count(total);
    badge.hidden = !total;
  }
  async function refresh() {
    if (destroyed || !source) return;
    const current = ++run;
    model.state = 'loading'; emit();
    try {
      const items = await source.list();
      if (destroyed || current !== run) return;
      Object.assign(model, { items, state: 'ready', error: null });
    } catch (error) {
      if (destroyed || current !== run) return;
      Object.assign(model, { state: 'error', error });
    }
    label(); emit();
  }
  /** Picks up `session.invites` once the shell provides it, then lists and watches share notifications. */
  function connect() {
    const next = context()?.session?.invites ?? null;
    element.hidden = !next;
    if (!next || next === source || destroyed) return;
    stopWatch?.(); stopWatch = null;
    source = next;
    void Promise.resolve().then(() => next.watch(() => void refresh())).then((off) => {
      if (destroyed || source !== next) off?.(); else stopWatch = off;
    }).catch(() => {});
    void refresh();
  }
  async function openDialog() {
    if (!source) return;
    const { openInbox } = await import('./inbox.js');
    if (!destroyed) dialog = openInbox(model);
  }
  label();
  return {
    /** The header button; reading it also connects to the current session. */
    get element() { connect(); return element; },
    refresh,
    destroy() { destroyed = true; stopWatch?.(); stopWatch = null; listeners.clear(); dialog?.close('navigation'); },
  };
}
