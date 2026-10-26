// Every photo and video of the journey in story order, grouped by day, opening the shared preview.
import { el, uid } from '../../ui/dom.js';
import { emptyState } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../lib/format.js';
import { galleryItems } from './model.js';
import { fileOf, isImageFile, isVideoFile, mediaTile } from './media.js';

/** `ctx`: `{space, ui, onMedia(fileId, ids), onEntry(entry)}`. Returns `{render(), destroy()}`. */
export function mountGallery(container, ctx) {
  const { space, ui } = ctx;
  const root = el('div.jr-gallery');
  container.replaceChildren(root);

  function render() {
    const usable = (id) => { const file = fileOf(space, id); return isImageFile(file) || isVideoFile(file); };
    const items = galleryItems(space.select.entry.all(), usable, { newestFirst: ui.newestFirst });
    if (!items.length) {
      root.replaceChildren(emptyState({ title: t('journey.galleryEmpty'), body: t('journey.galleryEmptyBody'), icon: 'pin' }));
      return;
    }
    const ids = items.map((item) => item.fileId);
    const groups = [];
    for (const item of items) {
      const last = groups.at(-1);
      if (last?.date === item.entry.date) last.items.push(item);
      else groups.push({ date: item.entry.date, items: [item] });
    }
    root.replaceChildren(el('p.jr-muted', {}, t('journey.photoCount', { count: formatNumber(items.length) })), ...groups.map((group) => {
      const headingId = uid('jr-gal');
      return el('section.jr-gallery-day', { 'aria-labelledby': headingId },
        el('h2.jr-gallery-head', { id: headingId }, formatDate(group.date, { weekday: true, style: 'long' })),
        el('ul.jr-gallery-grid', {}, group.items.map(({ fileId, entry }) => {
          const file = fileOf(space, fileId);
          const caption = file?.desc || '';
          return el('li.jr-gallery-item', {},
            el('button.jr-tile-button', { type: 'button', 'aria-label': t('journey.openPhotoFrom', { name: caption || file?.name || '', entry: entry.title }), onclick: () => ctx.onMedia(fileId, ids) },
              mediaTile(space, fileId, { className: 'jr-tile.jr-tile-large', alt: caption })),
            el('p.jr-gallery-caption', {}, caption && el('span', {}, caption),
              el('button.jr-link', { type: 'button', onclick: () => ctx.onEntry(entry) }, entry.title)));
        })));
    }));
  }

  render();
  return { render, destroy() { container.replaceChildren(); } };
}
