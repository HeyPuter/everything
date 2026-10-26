// Dashboard widget: the member's collections with links (`mountCollectionsWidget(container, context)`).
import './collections.css';
import { el, uid } from '../../ui/dom.js';
import { emptyState } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { spaceRoute } from '../../shared/protocol.js';
import { collectionBadge } from './metaform.js';
import { listCollections, peekMeta, personalOf } from './spaces.js';

const SHOWN = 6;

export function mountCollectionsWidget(container, context) {
  const titleId = uid('col-widget');
  const list = el('ul.col-widget-list', { 'aria-labelledby': titleId });
  const root = el('section.card.col-widget', { 'aria-labelledby': titleId },
    el('header.col-widget-head', {}, el('h3', { id: titleId }, t('collections.title')), el('a.col-widget-all', { href: '#/collections' }, t('collections.viewAll'))), list);
  container.replaceChildren(root);
  let destroyed = false;
  async function load() {
    if (!personalOf(context)) { list.replaceChildren(el('li', {}, t('collections.unavailable'))); return; }
    try {
      const entries = (await listCollections(context)).slice(0, SHOWN);
      const info = await peekMeta(context, entries);
      if (destroyed) return;
      if (!entries.length) { list.replaceChildren(el('li', {}, emptyState({ title: t('collections.emptyTitle'), body: t('collections.widgetEmpty'), icon: 'heart' }))); return; }
      list.replaceChildren(...entries.map((entry) => {
        const local = info.get(entry.ref.s);
        return el('li', {}, el('a.col-widget-row', { href: `${spaceRoute(entry.ref)}/places` }, collectionBadge(local?.meta, 28),
          el('span.col-card-name', {}, local?.meta?.name || entry.title || t('collections.untitled')),
          local && el('span.col-hint.num', {}, formatNumber(local.count))));
      }));
    } catch { if (!destroyed) list.replaceChildren(el('li.col-hint', {}, t('collections.loadFailed'))); }
  }
  void load();
  const off = personalOf(context)?.subscribe?.('me:spaces', () => void load());
  return () => { destroyed = true; off?.(); };
}
