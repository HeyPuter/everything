// `#/collections`: the member's collections in their own order, an "All saved" entry, create and import.
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, skeleton } from '../../ui/bits.js';
import { makeSortable } from '../../ui/dnd.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { spaceRoute } from '../../shared/protocol.js';
import { newId } from '../../shared/ids.js';
import { icon } from './icons.js';
import { collectionBadge, openMetaForm, placeCount } from './metaform.js';
import { coverUrl } from '../../lib/files/index.js';
import { chooseImport, importOps } from './io.js';
import { createCollection, errorText, listCollections, peekMeta, personalOf, saveOrder, uidOf, withSpace } from './spaces.js';
import { mountAllSaved } from './all.js';

const roleKey = { editor: 'collections.roleEditor', viewer: 'collections.roleViewer' };
export const collectionHash = (ref, tab = 'places') => `${spaceRoute(ref)}/${tab}`;

export function deployProgress(stage) {
  return t({ preparing: 'collections.deployPreparing', creating: 'collections.deployCreating', updating: 'collections.deployUpdating', starting: 'collections.deployStarting' }[stage] ?? 'collections.deployPreparing');
}

export function mountCollections(container, context) {
  const { app, signal } = context;
  const personal = personalOf(context);
  const me = uidOf(context);
  let entries = [];
  let info = new Map();
  let status = 'loading';
  let error = null;
  let sortable = null;
  let destroyed = false;
  let child = null;

  const titleId = uid('col-title');
  const countNode = el('span.col-count');
  const createButton = button(t('collections.new'), { icon: 'plus', variant: 'primary', onclick: () => create() });
  const importButton = button(t('collections.import'), { variant: 'outline', onclick: () => importNew() });
  importButton.prepend(icon('upload', 16));
  const body = el('div.col-list-body');
  const root = el('section.col-view.col-lists', { 'aria-labelledby': titleId },
    el('header.col-head', {}, el('div.col-heading', {}, el('h2', { id: titleId }, t('collections.title')), countNode),
      el('div.col-head-actions', {}, importButton, createButton)),
    body);
  container.replaceChildren(root);
  const session = context.session;
  if (!session?.api || !personal) {
    createButton.hidden = true; importButton.hidden = true;
    body.replaceChildren(emptyState({ title: t('collections.title'), body: t('collections.unavailable'), icon: 'heart' }));
    return () => { destroyed = true; };
  }

  function fileCover(ref, id) {
    const img = el('img.col-card-cover', { alt: '', hidden: true });
    coverUrl(ref, id, { thumb: true, api: session.api }).then((src) => { if (src) { img.src = src; img.hidden = false; } }).catch(() => {});
    return img;
  }
  function card(entry) {
    const local = info.get(entry.ref.s);
    const meta = local?.meta;
    const name = meta?.name || entry.title || t('collections.untitled');
    const cover = typeof meta?.cover === 'object' && meta.cover?.url ? meta.cover.url : null;
    const details = [local ? placeCount(local.count) : '', roleKey[entry.role] ? t(roleKey[entry.role]) : ''].filter(Boolean).join(' · ');
    return el('li.col-card', { dataset: { sortableItem: '', id: entry.ref.s, label: name } },
      el('a.col-card-link', { href: collectionHash(entry.ref) },
        cover ? el('img.col-card-cover', { src: cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (event) => event.target.remove() })
          : typeof meta?.cover === 'string' ? fileCover(entry.ref, meta.cover) : null,
        el('span.col-card-main', {}, collectionBadge(meta, 40),
          el('span.col-card-text', {}, el('span.col-card-name', {}, name), details && el('span.col-card-sub', {}, details)))),
      entries.length > 1 && el('button.col-grip', { type: 'button', dataset: { sortableHandle: '' }, 'aria-label': t('collections.reorder', { name }) }, icon('grip', 16)));
  }
  function render() {
    if (destroyed || child) return;
    sortable?.destroy(); sortable = null;
    countNode.textContent = status === 'ready' && entries.length ? formatNumber(entries.length) : '';
    if (status === 'loading') { body.replaceChildren(el('div.col-skeletons', { 'aria-busy': 'true' }, skeleton('60%'), skeleton('80%'), skeleton('70%'))); return; }
    if (status === 'error') {
      body.replaceChildren(emptyState({ title: t('collections.loadFailed'), body: errorText(error), icon: 'warning', action: button(t('collections.retry'), { variant: 'primary', onclick: () => void load() }) }));
      return;
    }
    const all = el('a.col-all', { href: '#/collections', onclick: (event) => { event.preventDefault(); openAll(); } },
      el('span.col-badge.col-badge-all', { 'aria-hidden': 'true' }, icon('all', 20)),
      el('span.col-card-text', {}, el('span.col-card-name', {}, t('collections.allSaved')), el('span.col-card-sub', {}, t('collections.allSavedHint'))),
      icon('chevronRight', 18));
    if (!entries.length) {
      body.replaceChildren(emptyState({ title: t('collections.emptyTitle'), body: t('collections.emptyBody'), icon: 'heart', action: button(t('collections.new'), { icon: 'plus', variant: 'primary', onclick: () => create() }) }));
      return;
    }
    const list = el('ul.col-grid', { 'aria-labelledby': titleId }, entries.map(card));
    body.replaceChildren(all, list);
    if (entries.length > 1) {
      sortable = makeSortable(list, { onMove: () => {
        const order = [...list.querySelectorAll('[data-id]')].map((node) => node.dataset.id);
        entries = order.map((id) => entries.find((entry) => entry.ref.s === id)).filter(Boolean);
        saveOrder(personal, order).catch(() => toast(t('collections.orderFailed')));
      } });
    }
  }
  async function load() {
    status = entries.length ? 'ready' : 'loading';
    render();
    try {
      entries = await listCollections(context);
      if (destroyed) return;
      status = 'ready';
      render();
      info = await peekMeta(context, entries);
      if (!destroyed) render();
    } catch (failure) {
      if (destroyed) return;
      error = failure; status = 'error'; render();
    }
  }

  function create(prefill = null) {
    const space = newId();
    return openMetaForm({
      meta: prefill, title: t('collections.newTitle'), submitLabel: t('collections.create'), describeError: errorText,
      onSubmit: async (values, { setProgress }) => {
        const ref = await createCollection(context, values, { space, onProgress: (stage) => setProgress(deployProgress(stage)) });
        if (!destroyed) app?.navigate(collectionHash(ref));
      },
    });
  }
  async function importNew() {
    const choice = await chooseImport({ uid: me });
    if (!choice || destroyed) return;
    const { parsed, status: chosen } = choice;
    const space = newId();
    openMetaForm({
      meta: { ...parsed.meta, name: parsed.meta.name || t('collections.importedName') }, title: t('collections.importNewTitle'), submitLabel: t('collections.importCreate'), describeError: errorText,
      onSubmit: async (values, { setProgress }) => {
        const ref = await createCollection(context, values, { space, onProgress: (stage) => setProgress(deployProgress(stage)) });
        setProgress(t('collections.importing'));
        const { value } = await withSpace(context, ref, (target) => {
          const result = importOps(target, parsed, { status: chosen });
          return target.apply(result.ops).then(() => result);
        }, { pull: true });
        toast(t('collections.imported', { count: formatNumber(value.added) }));
        if (!destroyed) app?.navigate(collectionHash(ref));
      },
    });
  }
  function openAll() {
    sortable?.destroy(); sortable = null;
    const slot = el('div.col-all-view');
    root.replaceChildren(slot);
    child = mountAllSaved(slot, { ...context, collections: entries, onBack: () => { child?.(); child = null; restore(); } });
  }
  function restore() {
    root.replaceChildren(el('header.col-head', {}, el('div.col-heading', {}, el('h2', { id: titleId, tabIndex: -1 }, t('collections.title')), countNode),
      el('div.col-head-actions', {}, importButton, createButton)), body);
    render();
    root.querySelector('h2')?.focus({ preventScroll: true });
  }

  const offIndex = personal.subscribe?.('me:spaces', () => { if (!destroyed && !child) void load(); });
  void load();
  const destroy = () => { destroyed = true; sortable?.destroy(); child?.(); offIndex?.(); };
  signal?.addEventListener('abort', destroy, { once: true });
  return destroy;
}
