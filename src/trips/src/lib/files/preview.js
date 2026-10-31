import './files.css';
import { el } from '../../ui/dom.js';
import { button, iconButton, spinner } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { markdown } from '../../ui/md.js';
import { toast } from '../../ui/toast.js';
import { t } from '../i18n/index.js';
import { errorKey } from './errors.js';
import { fileIcon, icon } from './icons.js';
import { canSaveToDrive, downloadFile, fileBlob, fileUrl, saveToDrive } from './index.js';
import { formatBytes } from './format.js';
import { previewKind } from './types.js';

const TEXT_LIMIT = 1024 * 1024;
const SWIPE = 48;

/** Toasts the outcome of "Save to my drive". The picker never settles when dismissed, so nothing waits on it. */
export function saveCopy(space, id) {
  saveToDrive(space, id).then((item) => toast(t('files.savedToDrive', { path: item?.path ?? item?.name ?? '' })),
    (error) => toast(t(errorKey(error))));
}

/** Starts a download and reports failures. */
export function download(space, id) {
  downloadFile(space, id).catch((error) => toast(t(errorKey(error))));
}

/**
 * Previews one trip file: images in a viewer with arrows, swipe and a strip of the other images in `ids`; PDFs in the
 * browser's viewer; markdown rendered safely; text as text. Other types offer a download. Returns the modal handle.
 */
export function openPreview(space, fileId, { ids = [fileId], onDetails } = {}) {
  const images = ids.filter((id) => ['image', 'heic', 'video'].includes(previewKind(space.get('file', id))));
  let current = fileId;
  let loadToken = 0;
  // Videos get their own object URL (outside the size-capped cache), revoked when the viewer moves on or closes.
  let videoUrl = null;
  const dropVideo = () => { if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; } };
  const stage = el('div.file-stage');
  const position = el('p.sr-only', { 'aria-live': 'polite' });
  const meta = el('p.file-preview-meta');
  const strip = el('div.file-strip', { role: 'group', 'aria-label': t('files.preview.strip') });
  const prev = iconButton('chevronLeft', t('files.preview.previous'), { class: 'icon-btn file-nav file-nav-prev', onclick: () => step(-1) });
  const next = iconButton('chevronRight', t('files.preview.next'), { class: 'icon-btn file-nav file-nav-next', onclick: () => step(1) });
  const actions = [
    button(t('files.action.download'), { onclick: () => download(space, current) }),
    canSaveToDrive() && button(t('files.action.saveToDrive'), { onclick: () => saveCopy(space, current) }),
    onDetails && button(t('files.action.details'), { onclick: () => { modal.close('details'); onDetails(current); } }),
  ].filter(Boolean);
  const body = el('div.file-preview', {}, el('div.file-stage-wrap', {}, prev, stage, next), meta, strip, position);
  const modal = openModal({ title: space.get('file', fileId)?.name ?? t('files.preview.title'), content: body, actions, wide: true, kind: 'file-viewer', onClose: () => dropVideo() });
  const titleNode = modal.panel.querySelector('.modal-title');

  function step(delta) {
    const index = images.indexOf(current);
    if (index < 0 || images.length < 2) return;
    show(images[(index + delta + images.length) % images.length]);
  }

  function renderStrip() {
    const inGallery = images.includes(current) && images.length > 1;
    prev.hidden = !inGallery; next.hidden = !inGallery; strip.hidden = !inGallery;
    if (!inGallery) { strip.replaceChildren(); return; }
    strip.replaceChildren(...images.map((id) => {
      const entity = space.get('file', id);
      const thumb = el('span.file-strip-thumb', {}, fileIcon(entity?.mime, 18));
      if (entity?.thumb) fileUrl(space, id, { thumb: true }).then((url) => { if (url) thumb.replaceChildren(el('img', { src: url, alt: '' })); }, () => {});
      return el('button.file-strip-item', { type: 'button', 'aria-label': entity?.name ?? '', 'aria-current': id === current ? 'true' : null, onclick: () => show(id) }, thumb);
    }));
    strip.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function failed(error, retry) {
    stage.replaceChildren(el('div.file-preview-empty', { role: 'alert' }, icon('alert', 28), el('p', {}, t(errorKey(error))),
      button(t('files.action.retry'), { size: 'sm', onclick: retry })));
  }

  function unavailable(entity, key) {
    stage.replaceChildren(el('div.file-preview-empty', {}, fileIcon(entity.mime, 32), el('p', {}, t(key)),
      button(t('files.action.download'), { variant: 'primary', size: 'sm', onclick: () => download(space, entity.id) })));
  }

  async function show(id) {
    const token = ++loadToken;
    current = id;
    dropVideo();
    const entity = space.get('file', id);
    if (!entity) { stage.replaceChildren(el('p.file-preview-empty', {}, t('files.preview.gone'))); return; }
    titleNode.textContent = entity.name;
    meta.textContent = [formatBytes(entity.size), entity.desc].filter(Boolean).join(' · ');
    renderStrip();
    const index = images.indexOf(id);
    position.textContent = index >= 0 && images.length > 1 ? t('files.preview.position', { name: entity.name, index: index + 1, count: images.length }) : '';
    const kind = previewKind(entity);
    if (kind === 'none') { unavailable(entity, entity.mime.includes('pkpass') ? 'files.preview.pass' : 'files.preview.none'); return; }
    const progress = el('progress.meter', { max: 1, 'aria-label': t('files.preview.loading') });
    stage.replaceChildren(el('div.file-preview-loading', {}, spinner(), progress));
    const onProgress = ({ loaded, total }) => { if (total > 0) { progress.max = total; progress.value = loaded; } };
    try {
      if (kind === 'markdown' || kind === 'text') {
        const blob = await fileBlob(space, id, { onProgress });
        if (token !== loadToken) return;
        const text = await blob.slice(0, TEXT_LIMIT).text();
        if (token !== loadToken) return;
        const view = el('div.file-text-view', { tabIndex: 0, 'aria-label': entity.name }, kind === 'markdown' ? markdown(text) : el('pre', {}, text));
        stage.replaceChildren(view, ...(blob.size > TEXT_LIMIT ? [el('p.field-hint', {}, t('files.preview.truncated'))] : []));
        return;
      }
      if (kind === 'video') {
        const blob = await fileBlob(space, id, { onProgress });
        if (token !== loadToken) return;
        videoUrl = URL.createObjectURL(blob);
        const video = el('video.file-video', { src: videoUrl, controls: true, preload: 'metadata', playsInline: true, 'aria-label': entity.desc || entity.name });
        video.addEventListener('error', () => { if (token === loadToken) unavailable(entity, 'files.preview.video'); }, { once: true });
        stage.replaceChildren(video);
        return;
      }
      const url = await fileUrl(space, id, { onProgress });
      if (token !== loadToken) return;
      if (kind === 'pdf') {
        stage.replaceChildren(el('iframe.file-pdf', { src: url, title: entity.name }));
        return;
      }
      const image = el('img.file-image', { src: url, alt: entity.desc || entity.name, draggable: false });
      // HEIC shows only where the platform decodes it.
      if (kind === 'heic') image.addEventListener('error', () => { if (token === loadToken) unavailable(entity, 'files.preview.heic'); }, { once: true });
      stage.replaceChildren(image);
    } catch (error) {
      if (token === loadToken) failed(error, () => show(id));
    }
  }

  modal.panel.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target.closest('input,textarea,select,iframe,video')) return;
    const rtl = getComputedStyle(modal.panel).direction === 'rtl';
    event.preventDefault();
    step((event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1));
  });
  let start = null;
  // Swipes on video controls scrub the video instead of changing files.
  stage.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse' && !event.target.closest?.('video')) start = { x: event.clientX, y: event.clientY }; });
  stage.addEventListener('pointerup', (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const rtl = getComputedStyle(modal.panel).direction === 'rtl';
      step((dx < 0 ? 1 : -1) * (rtl ? -1 : 1));
    }
  });
  stage.addEventListener('pointercancel', () => { start = null; });
  void show(fileId);
  return modal;
}
