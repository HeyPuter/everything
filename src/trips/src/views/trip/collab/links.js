import { el, safeURL } from '../../../ui/dom.js';
import { button, emptyState } from '../../../ui/bits.js';
import { checkbox, field } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { externalLink, favicon, formDialog, iconAction, keepFocus, reconcile, revisionOf, statusChip } from './common.js';
import { hostOf, normalizeURL, onStateKey, pinnedFirst, accessKey } from './model.js';

const byPinned = pinnedFirst('cr');

function linkFields(link) {
  const url = field({ label: t('collab.links.url'), value: link?.url ?? '', inputMode: 'url', placeholder: 'https://', maxLength: 2048, autocomplete: 'url', required: true });
  const title = field({ label: t('collab.links.titleLabel'), value: link?.title ?? '', maxLength: 500, hint: t('collab.links.titleHint') });
  return { url, title };
}

/** Reads the URL and title fields; null after showing a field error. */
function readLink({ url, title }) {
  const href = normalizeURL(url.input.value);
  url.setError(href ? '' : t(url.input.value.trim() ? 'collab.invalidURL' : 'collab.links.urlRequired'));
  if (!href) { url.input.focus(); return null; }
  return { url: href, title: title.input.value.trim() || hostOf(href) || href };
}

/** Trip links: title and URL, pinned links as favicon chips. */
export function mountLinks(container, ctx) {
  const { space } = ctx;
  let scheduled = false;
  let destroyed = false;
  let membersVersion = 0;
  const cache = new Map();

  const inputs = linkFields(null);
  const addForm = el('form.link-add', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    const value = readLink(inputs);
    if (!value) return;
    if (await ctx.apply([space.ops.create('link', { ...value, author: ctx.uid })], { history: t('collab.links.historyAdd'), flush: true })) {
      inputs.url.input.value = ''; inputs.title.input.value = '';
      inputs.url.input.focus();
    }
  } }, el('div.link-add-fields', {}, inputs.url.element, inputs.title.element), button(t('collab.links.add'), { type: 'submit', variant: 'primary', icon: 'plus' }));
  const chips = el('div.link-chips', { role: 'list', 'aria-label': t('collab.links.pinnedList') });
  const list = el('ul.card.link-list', { 'aria-label': t('collab.links.list') });
  const empty = el('div', { hidden: true });
  container.replaceChildren(el('div.collab-section', {}, addForm, chips, empty, list));

  function togglePin(link) {
    void ctx.apply([space.ops.patch('link', link.id, link.pinned ? { unset: ['pinned'] } : { set: { pinned: true } })], { flush: true });
  }
  function edit(link) {
    const fields = linkFields(link);
    let pinned = Boolean(link.pinned);
    formDialog(ctx, {
      title: t('collab.links.editTitle'), submitLabel: t('collab.save'),
      content: el('div', {}, fields.url.element, fields.title.element, checkbox(t('collab.links.pinLabel'), { checked: pinned, onChange: (value) => { pinned = value; } })),
      async onSubmit() {
        const value = readLink(fields);
        if (!value) return false;
        const current = space.get('link', link.id);
        if (!current) return t('collab.links.gone');
        const set = Object.fromEntries(Object.entries({ ...value, ...(pinned ? { pinned } : {}) }).filter(([key, item]) => current[key] !== item));
        const unset = !pinned && current.pinned ? ['pinned'] : [];
        if (!Object.keys(set).length && !unset.length) return true;
        return ctx.apply([space.ops.patch('link', link.id, { set, unset })], { history: t('collab.links.historyEdit'), flush: true });
      },
    });
  }
  async function remove(link) {
    if (await confirmDialog({ title: t('collab.links.deleteTitle'), body: t('collab.links.deleteBody', { title: link.title }), confirmLabel: t('collab.delete'), danger: true })) {
      await ctx.apply([space.ops.remove('link', link.id)], { flush: true });
    }
  }

  function row(link) {
    const manage = ctx.canManage(link);
    const overlay = space.overlay('link', link.id);
    return el('li.list-row.link-row', { dataset: { key: link.id } },
      favicon(link.url, 20),
      el('div.link-text', {}, externalLink(link.url, link.title), el('span.link-meta', {}, ctx.author(link).name, ' · ', ctx.timeNode(link.cr))),
      overlay.local && statusChip(t('collab.saving')),
      overlay.conflict && statusChip(t('collab.notSaved'), 'warn'),
      manage && iconAction(link.pinned ? 'unpin' : 'pinned', t(link.pinned ? 'collab.unpin' : 'collab.pin'), { 'aria-pressed': String(Boolean(link.pinned)), onclick: () => togglePin(link) }),
      manage && iconAction('more', t('collab.links.actions', { title: link.title }), { onclick: (event) => openMenu(event.currentTarget, [
        { label: t('collab.edit'), icon: 'pencil', onSelect: () => edit(link) },
        { separator: true },
        { label: t('collab.delete'), icon: 'trash', danger: true, onSelect: () => void remove(link) },
      ]) }));
  }

  function render() {
    scheduled = false;
    if (destroyed) return;
    addForm.hidden = !ctx.canPost();
    const links = space.select.link.all().slice().sort(byPinned);
    const pinned = links.filter((link) => link.pinned);
    chips.hidden = !pinned.length;
    const chipsSig = pinned.map(revisionOf).join(',');
    if (chipsSig !== chips.dataset.sig) {
      chips.dataset.sig = chipsSig;
      chips.replaceChildren(...pinned.map((link) => el('span', { role: 'listitem' },
        el('a.chip.link-chip', { href: safeURL(link.url), target: '_blank', rel: 'noopener noreferrer', title: link.url }, favicon(link.url, 16), el('bdi', {}, link.title)))));
    }
    const keep = new Set();
    keepFocus(list, () => reconcile(list, links.map((link) => {
      keep.add(link.id);
      const overlay = space.overlay('link', link.id);
      const sig = [revisionOf(link), overlay.local, overlay.conflict, ctx.canManage(link), membersVersion].join('|');
      const cached = cache.get(link.id);
      if (cached?.sig === sig) return cached.node;
      const node = row(link);
      cache.set(link.id, { sig, node });
      return node;
    })));
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    list.hidden = !links.length;
    empty.hidden = links.length > 0;
    if (!links.length) empty.replaceChildren(emptyState({ title: t('collab.links.emptyTitle'), body: t(ctx.canPost() ? 'collab.links.emptyBody' : 'collab.links.emptyReadOnly'), icon: 'copy' }));
  }
  function schedule() { if (!scheduled && !destroyed) { scheduled = true; queueMicrotask(render); } }

  const offs = [space.subscribe('link', schedule), space.subscribe('member', () => { membersVersion += 1; schedule(); }), onStateKey(space, accessKey, schedule)];
  render();
  return () => { destroyed = true; for (const off of offs) off(); };
}
