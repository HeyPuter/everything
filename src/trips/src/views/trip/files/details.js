import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { openModal } from '../../../ui/modal.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatInstant } from '../../../lib/format.js';
import { canSaveToDrive, errorKey, fileLinks, formatBytes, hasFileLink, linkFile, setDescription, setStar, unlinkFile } from '../../../lib/files/index.js';
import { download, openPreview, saveCopy } from '../../../lib/files/preview.js';
import { icon, iconAction, linkIcon } from '../../../lib/files/icons.js';
import { LINKABLE, linkCandidates, linkLabel, typeLabel } from '../../../lib/files/labels.js';
import { extensionOf } from '../../../lib/files/types.js';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const report = (promise) => promise.catch((error) => toast(t(errorKey(error))));

/** File details: facts, description, star and links. Editing needs `files.edit`; trashing goes through `onTrash`. */
export function openDetails(space, fileId, { onTrash } = {}) {
  const file = space.get('file', fileId);
  if (!file) return null;
  const canEdit = space.can('files.edit');
  const facts = el('dl.file-facts');
  const descId = uid('file-desc');
  const descInput = canEdit && el('textarea.textarea', { id: descId, rows: 3, maxLength: 100_000 });
  const descStatus = el('span.field-hint', { role: 'status' });
  let dirty = false;
  if (descInput) {
    descInput.value = file.desc ?? '';
    descInput.addEventListener('input', () => { dirty = descInput.value !== (space.get('file', fileId)?.desc ?? ''); descStatus.textContent = ''; });
  }
  const saveDesc = canEdit && button(t('ui.save'), { size: 'sm', onclick: async () => {
    try { await setDescription(space, fileId, descInput.value); dirty = false; descStatus.textContent = t('files.details.saved'); } catch (error) { descStatus.textContent = t(errorKey(error)); }
  } });
  const descView = el('div.file-desc');
  const descSection = el('section.file-section', {},
    canEdit ? el('label.file-section-title', { htmlFor: descId }, t('files.details.description')) : el('h3.file-section-title', {}, t('files.details.description')),
    canEdit ? el('div.file-desc-edit', {}, descInput, el('div.file-desc-actions', {}, saveDesc, descStatus)) : descView);
  const links = el('ul.file-links-list', { role: 'list' });
  const addLink = canEdit && button(t('files.action.addLink'), { size: 'sm', onclick: () => openLinkChooser(space, fileId) });
  const linksSection = el('section.file-section', {}, el('div.file-section-head', {}, el('h3.file-section-title', {}, t('files.details.links')), addLink), links);
  const star = canEdit && button('', { size: 'sm', variant: 'ghost', onclick: () => report(setStar(space, fileId, !space.get('file', fileId)?.star)) });
  const content = el('div.file-details', {}, facts, star && el('div.file-details-star', {}, star), descSection, linksSection);
  const actions = [
    button(t('files.action.preview'), { onclick: () => { modal.close('preview'); openPreview(space, fileId); } }),
    button(t('files.action.download'), { onclick: () => download(space, fileId) }),
    canSaveToDrive() && button(t('files.action.saveToDrive'), { onclick: () => saveCopy(space, fileId) }),
    onTrash && space.can('files.delete') && !file.trashed && button(t('files.action.trash'), { variant: 'danger', onclick: () => { modal.close('trash'); onTrash(fileId); } }),
  ].filter(Boolean);
  const modal = openModal({ title: file.name, content, actions, wide: true });

  function render() {
    const current = space.get('file', fileId);
    if (!current) { modal.close('gone'); toast(t('files.preview.gone')); return; }
    modal.panel.querySelector('.modal-title').textContent = current.name;
    facts.replaceChildren(...[
      el('dt', {}, t('files.details.type')), el('dd', {}, (extensionOf(current.name) || current.mime).toUpperCase()),
      el('dt', {}, t('files.details.size')), el('dd', {}, formatBytes(current.size)),
      el('dt', {}, t('files.details.added')), el('dd', {}, formatInstant(current.cr ?? Date.now(), zone(), { time: false, style: 'long' })),
      current.trashed && el('dt', {}, t('files.details.trashed')), current.trashed && el('dd', {}, formatInstant(current.trashed, zone(), { time: false, style: 'long' })),
    ].filter(Boolean));
    if (star) {
      star.replaceChildren(icon('star', 16, { filled: Boolean(current.star) }), el('span', {}, t(current.star ? 'files.action.unstar' : 'files.action.star')));
      star.setAttribute('aria-pressed', String(Boolean(current.star)));
    }
    if (descInput && !dirty && doc().activeElement !== descInput) descInput.value = current.desc ?? '';
    if (!canEdit) descView.replaceChildren(current.desc ? markdown(current.desc) : el('p.field-hint', {}, t('files.details.noDescription')));
    const items = fileLinks(current);
    links.replaceChildren(...(items.length ? items.map((link) => el('li.file-link', {},
      linkIcon(link.t, 16), el('span.file-link-type', {}, typeLabel(link.t)), el('span.file-link-label', {}, linkLabel(space, link)),
      canEdit && link.t !== 'meta' && iconAction('close', t('files.action.unlinkName', { name: linkLabel(space, link) }), { small: true, onclick: () => report(unlinkFile(space, fileId, link)) })))
      : [el('li.field-hint', {}, t('files.details.noLinks'))]));
  }
  const doc = () => modal.panel.ownerDocument;
  const off = space.subscribe((event) => { if ([...event.types].some((type) => ['file', 'place', 'res', 'visit', 'exp', 'note', 'day'].includes(type))) render(); });
  void modal.closed.then(off);
  render();
  return modal;
}

/** Toggles links from one file to places, bookings, visits, expenses and notes. Changes save at once. */
export function openLinkChooser(space, fileId) {
  const searchId = uid('link-search');
  const search = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', oninput: () => render() });
  const list = el('div.file-link-choices');
  const linked = (target) => hasFileLink(space.get('file', fileId), target);
  function render() {
    const candidates = linkCandidates(space, search.value);
    if (!candidates.length) { list.replaceChildren(el('p.field-hint', {}, t(search.value.trim() ? 'files.empty.search' : 'files.link.nothing'))); return; }
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    list.replaceChildren(...LINKABLE.flatMap((type) => {
      const group = candidates.filter((item) => item.t === type);
      if (!group.length) return [];
      const headingId = uid('link-group');
      return el('div.file-link-group', { role: 'group', 'aria-labelledby': headingId },
        el('h3.file-link-group-title', { id: headingId }, typeLabel(type)),
        group.map((item) => el('button.pick-item', {
          type: 'button', role: 'checkbox', 'aria-checked': String(linked(item)), dataset: { key: `${item.t}:${item.id}` },
          onclick: () => report(linked(item) ? unlinkFile(space, fileId, item) : linkFile(space, fileId, item)),
        }, linkIcon(item.t, 16), el('span', {}, item.label))));
    }));
    if (focused) list.querySelector(`[data-key="${focused}"]`)?.focus();
  }
  const modal = openModal({
    title: t('files.link.title', { name: space.get('file', fileId)?.name ?? '' }),
    content: el('div.file-link-chooser', {}, el('div.field', {}, el('label.field-label', { htmlFor: searchId }, t('files.link.search')), search), list),
    actions: [button(t('files.picker.done'), { variant: 'primary', onclick: () => modal.close('done') })],
    wide: true,
  });
  const off = space.subscribe((event) => { if ([...event.types].some((type) => ['file', ...LINKABLE].includes(type))) render(); });
  void modal.closed.then(off);
  render();
  return modal;
}
