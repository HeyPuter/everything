// Trip cover pickers. Uploads and file covers go through the files module (`uploadCover`, `coverUrl`); search uses
// Openverse and Wikimedia Commons through session.services.
import { el, safeURL, uid } from '../../../ui/dom.js';
import { button, spinner } from '../../../ui/bits.js';
import { field, segmented } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { coverUrl } from '../../../lib/files/index.js';
import { countText } from './meta.js';

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE = /^image\/(?:jpeg|png|webp|gif|avif|heic|heif)$/;

/** A displayable URL for a stored cover (a trip file id or `{url}`), or null. `thumb` prefers the small rendition. */
export async function coverURL(cover, { space, ref, thumb = false } = {}) {
  if (!cover) return null;
  try { return await coverUrl(space ?? ref, cover, { thumb }); } catch { return null; }
}

export function checkImage(file) {
  if (!file || !IMAGE.test(file.type)) return 'trip.coverNotImage';
  if (file.size > MAX_BYTES) return 'trip.coverTooBig';
  return null;
}

function creditOf(photo) {
  return [photo.author, photo.license, photo.provider === 'wikimedia' ? 'Wikimedia Commons' : photo.provider === 'openverse' ? 'Openverse' : photo.provider === 'unsplash' ? 'Unsplash' : '']
    .filter(Boolean).join(' · ').slice(0, 500);
}

/**
 * Picks a cover. Resolves `{file}` (an image to upload), `{value}` (a ready cover such as `{url, credit}`),
 * `{remove: true}`, or null when cancelled. `query` seeds the image search.
 */
export function pickCover({ session, puter, query = '', current = null }) {
  return new Promise((resolve) => {
    let result = null;
    const status = el('p.cover-status', { role: 'status' });
    const panels = {};
    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => choose(fileInput.files?.[0]) });
    function choose(file) {
      const problem = checkImage(file);
      if (problem) { status.textContent = t(problem); return; }
      result = { file }; dialog.close('picked');
    }
    const drop = el('div.cover-drop', {
      ondragover: (event) => { event.preventDefault(); drop.classList.add('is-over'); },
      ondragleave: () => drop.classList.remove('is-over'),
      ondrop: (event) => { event.preventDefault(); drop.classList.remove('is-over'); choose(event.dataTransfer?.files?.[0]); },
    }, el('p', {}, t('trip.coverDropHint')), button(t('trip.coverChoose'), { icon: 'plus', onclick: () => fileInput.click() }), fileInput);
    panels.upload = el('div.cover-panel', {}, drop);

    const search = field({ label: t('trip.coverSearchLabel'), type: 'search', value: query, prefix: 'search', autocomplete: 'off' });
    const grid = el('div.cover-grid', { role: 'list', 'aria-label': t('trip.coverResults') });
    const attribution = el('p.cover-attribution');
    let searchRun = 0;
    async function runSearch() {
      const q = search.input.value.trim();
      const run = ++searchRun;
      if (q.length < 3) { grid.replaceChildren(); status.textContent = t('trip.coverSearchShort'); return; }
      grid.replaceChildren(spinner()); status.textContent = '';
      try {
        const found = await session.services.images.search(q);
        if (run !== searchRun) return;
        const photos = found?.data ?? [];
        grid.replaceChildren(...photos.map((photo) => el('div', { role: 'listitem' }, el('button.cover-result', {
          type: 'button', title: creditOf(photo), 'aria-label': t('trip.coverUse', { name: photo.title || creditOf(photo) || t('trip.cover') }),
          onclick: () => { void session.services.images.markUsed(photo).catch(() => {}); result = { value: { url: photo.url, ...(creditOf(photo) ? { credit: creditOf(photo) } : {}) } }; dialog.close('picked'); },
        }, el('img', { src: safeURL(photo.thumbnail) ?? '', alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })))));
        attribution.textContent = (found?.attribution ?? []).map((item) => [item.text, item.license].filter(Boolean).join(' · ')).join(' · ');
        status.textContent = found === null ? t('trip.coverSearchOffline') : photos.length ? countText('trip.coverResultsCount', photos.length) : t('trip.coverNoResults');
      } catch {
        if (run === searchRun) { grid.replaceChildren(); status.textContent = t('trip.coverSearchFailed'); }
      }
    }
    const searchForm = el('form.cover-search', { onsubmit: (event) => { event.preventDefault(); void runSearch(); } }, search.element, button(t('trip.coverSearch'), { type: 'submit' }));
    panels.search = el('div.cover-panel', {}, searchForm, grid, attribution);

    const canPick = typeof puter?.ui?.showOpenFilePicker === 'function';
    if (canPick) {
      panels.drive = el('div.cover-panel', {}, el('p', {}, t('trip.coverDriveHint')), button(t('trip.coverDrive'), { onclick: async (event) => {
        const control = event.currentTarget;
        control.setAttribute('aria-busy', 'true');
        try {
          const picked = await puter.ui.showOpenFilePicker({ accept: 'image/*' });
          const item = Array.isArray(picked) ? picked[0] : picked;
          if (!item) return;
          const blob = typeof item.read === 'function' ? await item.read() : await puter.fs.read(item.path);
          choose(new File([blob], item.name ?? 'cover', { type: blob.type || 'image/jpeg' }));
        } catch { status.textContent = t('trip.coverDriveFailed'); }
        finally { control.setAttribute('aria-busy', 'false'); }
      } }));
    }

    const link = field({ label: t('trip.coverLinkLabel'), type: 'url', placeholder: 'https://', autocomplete: 'off' });
    panels.link = el('form.cover-panel', { onsubmit: (event) => {
      event.preventDefault();
      const url = safeURL(link.input.value.trim());
      if (!url) { link.setError(t('trip.coverLinkInvalid')); return; }
      result = { value: { url } }; dialog.close('picked');
    } }, link.element, button(t('trip.coverUseLink'), { type: 'submit', variant: 'primary' }));

    const ids = Object.keys(panels);
    const body = el('div.cover-body');
    const show = (id) => { body.replaceChildren(panels[id]); status.textContent = ''; if (id === 'search' && search.input.value.trim().length >= 3 && !grid.children.length) void runSearch(); };
    const tabs = segmented({ label: t('trip.coverSource'), value: 'upload', onChange: show,
      items: ids.map((id) => ({ value: id, label: t(`trip.coverTab_${id}`) })) });
    function onPaste(event) {
      const file = [...(event.clipboardData?.files ?? [])][0];
      if (file) { event.preventDefault(); choose(file); return; }
      const text = event.clipboardData?.getData('text')?.trim();
      if (text && safeURL(text) && !event.target.closest?.('input,textarea')) { event.preventDefault(); result = { value: { url: safeURL(text) } }; dialog.close('picked'); }
    }
    const actions = [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') })];
    if (current) actions.unshift(button(t('trip.coverRemove'), { variant: 'danger', onclick: () => { result = { remove: true }; dialog.close('picked'); } }));
    const labelId = uid('cover');
    const dialog = openModal({
      title: t('trip.coverTitle'), wide: true,
      content: el('div.cover-picker', { 'aria-describedby': labelId, onpaste: onPaste }, tabs.element, body, el('p.field-hint', { id: labelId }, t('trip.coverPasteHint')), status),
      actions, onClose: () => resolve(result),
    });
    show('upload');
  });
}
