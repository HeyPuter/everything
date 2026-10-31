import { el, uid as nodeId, append, clear } from '../../../ui/dom.js';
import { button, emptyState } from '../../../ui/bits.js';
import { checkbox, field, segmented } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { markdown } from '../../../ui/md.js';
import { t } from '../../../lib/i18n/index.js';
import { externalLink, favicon, formDialog, icon, iconAction, keepFocus, reconcile, revisionOf, statusChip } from './common.js';
import { attachmentList, openAttachPicker } from './attach.js';
import { NOTE_COLORS, authorOf, filesByLink, normalizeURL, noteCategories, noteColor, noteColorOf, onStateKey, pinnedFirst, accessKey, sameCategory } from './model.js';

const byPinned = pinnedFirst('upd');

/** Shared notes: markdown body, category and color, website, pin, attachments, expanded view and a category filter. */
export function mountNotes(container, ctx) {
  const { space } = ctx;
  let filter = null;
  let scheduled = false;
  let destroyed = false;
  const cache = new Map();

  const addButton = button(t('collab.notes.add'), { variant: 'primary', size: 'sm', icon: 'plus', onclick: () => openNoteForm() });
  const filters = el('div.collab-filters', { role: 'group', 'aria-label': t('collab.notes.filter') });
  const grid = el('ul.note-grid', { 'aria-label': t('collab.notes.list') });
  const empty = el('div', { hidden: true });
  container.replaceChildren(el('div.collab-section', {}, el('div.collab-toolbar', {}, filters, addButton), empty, grid));

  const categories = () => noteCategories(space.select.note.all(), space.select.listMeta.all());

  function filterButton(label, key, color) {
    return el('button.collab-filter', { type: 'button', dataset: { key: key ?? '' }, onclick: () => { filter = key; render(); } },
      color && el('span.note-swatch', { dataset: { color: String(color) }, 'aria-hidden': 'true' }), el('bdi', {}, label));
  }
  /** Rebuilds the filter buttons only when the categories change, keeping focus on the same one. */
  function renderFilters(cats) {
    const sig = cats.map((cat) => `${cat.key}:${cat.name}:${cat.color}`).join('|');
    if (sig !== filters.dataset.sig) {
      const focused = filters.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      filters.dataset.sig = sig;
      filters.replaceChildren(...(cats.length ? [filterButton(t('collab.notes.all'), null), ...cats.map((cat) => filterButton(cat.name, cat.key, cat.color))] : []));
      if (focused !== null) [...filters.children].find((node) => node.dataset.key === focused)?.focus();
    }
    for (const node of filters.children) node.setAttribute('aria-pressed', String((filter ?? '') === node.dataset.key));
    filters.hidden = !cats.length;
  }

  function card(note, cats, files) {
    const color = noteColorOf(note, cats);
    const overlay = space.overlay('note', note.id);
    const manage = ctx.canManage(note);
    const author = ctx.author(note);
    const title = el('h3.note-title', {}, el('button.note-open', { type: 'button', onclick: () => openNoteView(note.id) }, el('bdi', {}, note.title)));
    const preview = note.body?.trim() ? markdown(note.body.length > 1200 ? `${note.body.slice(0, 1200)}…` : note.body) : null;
    preview?.classList.add('note-preview');
    const pin = manage && iconAction(note.pinned ? 'unpin' : 'pinned', t(note.pinned ? 'collab.unpin' : 'collab.pin'), { 'aria-pressed': String(Boolean(note.pinned)), onclick: () => togglePin(note) });
    const more = iconAction('more', t('collab.notes.actions', { title: note.title }), { onclick: (event) => menu(note, event.currentTarget) });
    return el('li', { dataset: { key: note.id } }, el(`article.note-card${color ? '' : '.is-plain'}`, { dataset: { color: String(color ?? 0) }, 'aria-label': note.title },
      el('div.note-head', {}, note.pinned && el('span.note-pinned', { title: t('collab.pinned') }, icon('pinned', 14), el('span.sr-only', {}, t('collab.pinned'))), title, pin, more),
      note.cat && statusChip(note.cat),
      preview,
      note.web && el('div.note-web', {}, favicon(note.web, 20), externalLink(note.web, new URL(note.web).hostname.replace(/^www\./, ''))),
      el('div.note-foot', {},
        ctx.avatarOf(authorOf(note), 22), el('span.note-meta', {}, author.name, ' · ', ctx.timeNode(note.upd ?? note.cr)),
        files.length > 0 && el('span.note-files', { title: t('collab.attachments') }, icon('attach', 14), el('span.num', {}, String(files.length)), el('span.sr-only', {}, t('collab.attachments'))),
        overlay.conflict && statusChip(t('collab.notSaved'), 'warn'),
        overlay.local && statusChip(t('collab.saving')))));
  }

  function render() {
    scheduled = false;
    if (destroyed) return;
    const cats = categories();
    if (filter && !cats.some((cat) => cat.key === filter)) filter = null;
    renderFilters(cats);
    addButton.hidden = !ctx.canPost();
    const notes = space.select.note.all().filter((note) => !filter || sameCategory(note, filter)).sort(byPinned);
    const filesMap = filesByLink(space.select.file.all(), 'note');
    const keep = new Set();
    const nodes = notes.map((note) => {
      keep.add(note.id);
      const files = filesMap.get(note.id) ?? [];
      const overlay = space.overlay('note', note.id);
      const sig = [revisionOf(note), overlay.local, overlay.conflict, ctx.canManage(note), files.map(revisionOf).join(','), cats.map((cat) => `${cat.key}:${cat.color}`).join(',')].join('|');
      const cached = cache.get(note.id);
      if (cached?.sig === sig) return cached.node;
      const node = card(note, cats, files);
      cache.set(note.id, { sig, node });
      return node;
    });
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    keepFocus(grid, () => reconcile(grid, nodes));
    empty.hidden = notes.length > 0;
    if (!notes.length) {
      empty.replaceChildren(filter
        ? emptyState({ title: t('collab.notes.noneInCategory'), icon: 'file' })
        : emptyState({ title: t('collab.notes.emptyTitle'), body: t('collab.notes.emptyBody'), icon: 'file',
          action: ctx.canPost() && button(t('collab.notes.add'), { variant: 'primary', icon: 'plus', onclick: () => openNoteForm() }) }));
    }
  }
  function schedule() { if (!scheduled && !destroyed) { scheduled = true; queueMicrotask(render); } }

  function togglePin(note) {
    void ctx.apply([space.ops.patch('note', note.id, note.pinned ? { unset: ['pinned'] } : { set: { pinned: true } })], { flush: true });
  }
  async function remove(note) {
    const ok = await confirmDialog({ title: t('collab.notes.deleteTitle'), body: t('collab.notes.deleteBody', { title: note.title }), confirmLabel: t('collab.delete'), danger: true });
    if (ok) await ctx.apply([space.ops.remove('note', note.id, { base: true })], { flush: true });
    return ok;
  }
  function menu(note, anchor) {
    const manage = ctx.canManage(note);
    openMenu(anchor, [
      { label: t('collab.notes.open'), onSelect: () => openNoteView(note.id) },
      manage && { label: t('collab.edit'), icon: 'pencil', onSelect: () => openNoteForm(note) },
      manage && { label: t(note.pinned ? 'collab.unpin' : 'collab.pin'), onSelect: () => togglePin(note) },
      space.can('files.edit') && { label: t('collab.attach.action'), onSelect: () => openAttachPicker(ctx, { type: 'note', id: note.id }) },
      manage && { separator: true },
      manage && { label: t('collab.delete'), icon: 'trash', danger: true, onSelect: () => void remove(note) },
    ].filter(Boolean));
  }

  function openNoteView(id) {
    const content = el('div.note-view');
    const actions = el('div.modal-actions');
    let dialog;
    const draw = () => {
      const note = space.get('note', id);
      if (!note) { dialog?.close('gone'); return; }
      const cats = categories();
      const color = noteColorOf(note, cats);
      const files = filesByLink(space.select.file.all(), 'note').get(id) ?? [];
      const manage = ctx.canManage(note);
      content.dataset.color = String(color ?? 0);
      append(clear(content), [
        el('div.note-view-meta', {}, note.cat && statusChip(note.cat), note.pinned && statusChip(t('collab.pinned'), 'accent'),
          ctx.avatarOf(authorOf(note), 22), el('span', {}, ctx.author(note).name, ' · ', ctx.timeNode(note.upd ?? note.cr))),
        note.body?.trim() ? markdown(note.body) : el('p.note-empty-body', {}, t('collab.notes.noBody')),
        note.web && el('div.note-web.is-large', {}, favicon(note.web, 32), externalLink(note.web, note.web)),
        files.length > 0 && el('h3.note-view-heading', {}, t('collab.attachments')),
        attachmentList(ctx, { type: 'note', id, files })]);
      actions.replaceChildren(...[
        space.can('files.edit') && button(t('collab.attach.action'), { size: 'sm', onclick: () => openAttachPicker(ctx, { type: 'note', id }) }),
        manage && button(t(note.pinned ? 'collab.unpin' : 'collab.pin'), { size: 'sm', onclick: () => togglePin(note) }),
        manage && button(t('collab.delete'), { size: 'sm', variant: 'danger', onclick: async () => { if (await remove(note)) dialog.close('deleted'); } }),
        manage && button(t('collab.edit'), { size: 'sm', variant: 'primary', icon: 'pencil', onclick: () => openNoteForm(note) }),
      ].filter(Boolean));
      if (dialog) dialog.panel.querySelector('.modal-title').textContent = note.title;
    };
    draw();
    const note = space.get('note', id);
    if (!note) return;
    dialog = ctx.track(openModal({ title: note.title, content: el('div', {}, content, actions), wide: true }));
    const offs = [space.subscribe({ type: 'note', id }, draw), space.subscribe('file', draw)];
    void dialog.closed.then(() => offs.forEach((off) => off()));
  }

  function openNoteForm(note = null) {
    const cats = categories();
    const title = field({ label: t('collab.notes.titleLabel'), value: note?.title ?? '', required: true, maxLength: 500 });
    const body = field({ label: t('collab.notes.body'), type: 'textarea', value: note?.body ?? '', hint: t('collab.markdownHint'), maxLength: 100_000, rows: 8 });
    const listId = nodeId('note-cats');
    const cat = field({ label: t('collab.notes.category'), value: note?.cat ?? '', maxLength: 500, list: listId, hint: t('collab.notes.categoryHint'), autocomplete: 'off' });
    let color = noteColor(note?.color) ?? 0;
    let colorTouched = Boolean(note);
    const colors = segmented({
      label: t('collab.notes.color'), radio: true, value: color,
      items: [{ value: 0, label: t('collab.color.none') }, ...NOTE_COLORS.map((value) => ({ value, label: t(`collab.color.${value}`) }))],
      onChange: (value) => { color = value; colorTouched = true; },
    });
    colors.element.classList.add('note-colors');
    [...colors.element.children].forEach((node, index) => { if (index) node.prepend(el('span.note-swatch', { dataset: { color: String(index) }, 'aria-hidden': 'true' })); });
    cat.input.addEventListener('change', () => {
      const match = cats.find((item) => item.key === cat.input.value.trim().toLocaleLowerCase());
      if (match?.color && !colorTouched) { color = match.color; colors.setValue(match.color); }
    });
    const web = field({ label: t('collab.notes.website'), value: note?.web ?? '', inputMode: 'url', placeholder: 'https://', maxLength: 2048, autocomplete: 'url' });
    let pinned = Boolean(note?.pinned);
    const pinField = checkbox(t('collab.notes.pinLabel'), { checked: pinned, onChange: (value) => { pinned = value; } });
    const content = el('div', {}, title.element, body.element, cat.element, el('datalist', { id: listId }, cats.map((item) => el('option', { value: item.name }))),
      el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('collab.notes.color')), colors.element),
      web.element, pinField);
    return formDialog(ctx, {
      title: t(note ? 'collab.notes.editTitle' : 'collab.notes.newTitle'), content, wide: true, submitLabel: t(note ? 'collab.save' : 'collab.notes.create'),
      async onSubmit() {
        const titleValue = title.input.value.trim();
        title.setError(titleValue ? '' : t('collab.notes.titleRequired'));
        const webValue = web.input.value.trim() ? normalizeURL(web.input.value) : '';
        web.setError(webValue === null ? t('collab.invalidURL') : '');
        if (!titleValue) { title.input.focus(); return false; }
        if (webValue === null) { web.input.focus(); return false; }
        const next = { title: titleValue, body: body.input.value.trim() ? body.input.value : '', cat: cat.input.value.trim(), color: color || null, web: webValue, pinned };
        if (!note) {
          const fields = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '' && value !== null && value !== false));
          return ctx.apply([space.ops.create('note', { ...fields, author: ctx.uid })], { history: t('collab.notes.historyAdd'), flush: true });
        }
        const current = space.get('note', note.id);
        if (!current) return t('collab.notes.gone');
        const set = {};
        const unset = [];
        for (const [key, value] of Object.entries(next)) {
          if (value === '' || value === null || value === false) { if (current[key] !== undefined) unset.push(key); }
          else if (current[key] !== value) set[key] = value;
        }
        if (!Object.keys(set).length && !unset.length) return true;
        return ctx.apply([space.ops.patch('note', note.id, { set, unset }, { base: true })], { history: t('collab.notes.historyEdit'), flush: true });
      },
    });
  }

  const offs = [space.subscribe('note', schedule), space.subscribe('listMeta', schedule), space.subscribe('file', schedule), space.subscribe('member', () => { cache.clear(); schedule(); }), onStateKey(space, accessKey, schedule)];
  render();
  return () => { destroyed = true; for (const off of offs) off(); cache.clear(); };
}

