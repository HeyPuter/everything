import { el } from '../../ui/dom.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { saveBlob } from '../../lib/download.js';
import { fetchPublicFile } from '../../lib/api.js';
import { icon } from '../trip/plan/icons.js';

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const units = ['B', 'KB', 'MB', 'GB'];
export function sizeText(bytes) {
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`;
}

/**
 * Downloads through the public file route. Images become object URLs (cached, revoked on `destroy`); other files
 * are saved with their name. The worker serves only raster images inline.
 */
export function createFiles({ puter, link, signal }) {
  const images = new Map();
  const urls = new Set();
  const url = (blob) => { const value = URL.createObjectURL(blob); urls.add(value); return value; };
  return {
    isImage: (file) => RASTER.has(file?.mime),
    image(fileId) {
      if (!images.has(fileId)) {
        const job = fetchPublicFile(puter, link, fileId, { signal }).then((blob) => (RASTER.has(blob.type) ? url(blob) : null));
        job.catch(() => images.delete(fileId));
        images.set(fileId, job);
      }
      return images.get(fileId);
    },
    async download(file, control) {
      control?.setAttribute('aria-busy', 'true');
      try {
        const blob = await fetchPublicFile(puter, link, file.id, { signal });
        saveBlob(new Blob([blob], { type: 'application/octet-stream' }), file.name);
      } catch (error) {
        if (!signal?.aborted) toast(t(error?.status === 413 ? 'public.fileTooLarge' : 'public.downloadFailed'));
      } finally { control?.setAttribute('aria-busy', 'false'); }
    },
    destroy() { for (const value of urls) URL.revokeObjectURL(value); urls.clear(); images.clear(); },
  };
}

/** An `<img>` filled from the public file route; it stays hidden if the image cannot be loaded. */
export function remoteImage(files, fileId, { alt = '', className = '' } = {}) {
  const image = el(`img${className ? `.${className}` : ''}`, { alt, hidden: true, decoding: 'async' });
  void files.image(fileId).then((src) => { if (src) { image.src = src; image.hidden = false; } }).catch(() => {});
  return image;
}

/** Files linked to one entity, as download buttons. */
export function attachments(files, list) {
  if (!list.length) return null;
  return el('ul.public-files', { 'aria-label': t('public.attachments') }, list.map((file) => {
    const control = el('button.public-file', { type: 'button', 'aria-label': t('public.download', { name: file.name }), onclick: () => void files.download(file, control) },
      icon(files.isImage(file) ? 'camera' : 'file', 15), el('span.public-file-name', {}, file.name), el('span.public-file-size.num', {}, sizeText(file.size)));
    return el('li', {}, control);
  }));
}

/** Files of a projection grouped by linked entity key `t:id`. */
export function filesByEntity(projection) {
  const map = new Map();
  for (const file of projection.files) {
    for (const link of file.links) {
      const key = `${link.t}:${link.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(file);
    }
  }
  return map;
}
