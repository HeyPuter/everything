// "Photos near this entry": scans a folder of the user's Puter drive for JPEGs taken on (or a day around) the entry's
// date and, when both have coordinates, close to its place. Reads only the first bytes of each file until picked.
import { el, uid } from '../../ui/dom.js';
import { button, spinner } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../lib/format.js';
import { daysBetween, isDate } from '../../shared/dates.js';
import { pool } from '../../shared/pool.js';
import { readExif } from './exif.js';
import { distanceMeters } from '../../shared/geo.js';

const HEAD_BYTES = 128 * 1024;
const SCAN_LIMIT = 400;
const SHOW_LIMIT = 24;
const NEAR_METERS = 25_000;
const JPEG = /\.jpe?g$/i;

export const canScanDrive = (puter) => typeof puter?.ui?.showDirectoryPicker === 'function' && typeof puter?.fs?.readdir === 'function' && typeof puter?.fs?.read === 'function';

/**
 * A score for how well a photo's EXIF fits an entry (lower is better), or null when it does not fit: the capture date
 * must be within a day, and when both have coordinates the photo must be within 25 km.
 */
export function nearbyScore(exif, { date, loc }) {
  if (!exif || !isDate(exif.date) || !isDate(date)) return null;
  const days = Math.abs(daysBetween(date, exif.date));
  if (days > 1) return null;
  let meters = null;
  if (Number.isFinite(loc?.lat) && Number.isFinite(exif.lat)) {
    meters = distanceMeters(loc, exif);
    if (meters > NEAR_METERS) return null;
  }
  return days * NEAR_METERS + (meters ?? NEAR_METERS / 2);
}

export function openNearby({ puter, date, loc, onAdd }) {
  const urls = new Set();
  const chosen = new Set();
  let found = [];
  let closed = false;
  const status = el('p.jr-hint', { role: 'status' }, t('journey.nearbyIntro', { date: formatDate(date, { style: 'long' }) }));
  const grid = el('ul.jr-nearby-grid', { 'aria-label': t('journey.nearbyResults') });
  const pick = button(t('journey.nearbyChoose'), { variant: 'outline', onclick: () => void choose() });
  const add = button(t('journey.nearbyAdd', { count: 0 }), { variant: 'primary', disabled: true, onclick: () => void addChosen() });
  const dialog = openModal({ title: t('journey.nearbyTitle'), wide: true, content: el('div.jr-nearby', {}, status, pick, grid),
    actions: [button(t('journey.cancel'), { onclick: () => dialog.close('cancel') }), add],
    onClose: () => { closed = true; for (const url of urls) URL.revokeObjectURL(url); } });

  const update = () => { add.textContent = t('journey.nearbyAdd', { count: chosen.size }); add.disabled = !chosen.size; };

  async function choose() {
    // Puter's pickers never settle when dismissed, so nothing else waits on this.
    const folder = await puter.ui.showDirectoryPicker();
    if (closed || !folder) return;
    pick.disabled = true;
    status.replaceChildren(spinner(), t('journey.nearbyScanning'));
    let items = [];
    try { items = (await puter.fs.readdir(folder.path ?? folder)) ?? []; } catch { status.textContent = t('journey.nearbyFailed'); pick.disabled = false; return; }
    const photos = items.filter((item) => !item.is_dir && JPEG.test(item.name ?? '')).sort((a, b) => (Number(b.modified) || 0) - (Number(a.modified) || 0)).slice(0, SCAN_LIMIT);
    const scored = [];
    await pool(photos, 4, async (item) => {
      if (closed) return;
      try {
        const head = await puter.fs.read(item.path, { offset: 0, byte_count: HEAD_BYTES });
        const bytes = new Uint8Array(await (head instanceof Blob ? head : new Blob([head])).slice(0, HEAD_BYTES).arrayBuffer());
        const exif = readExif(bytes);
        const score = nearbyScore(exif, { date, loc });
        if (score !== null) scored.push({ item, exif, score });
      } catch { /* unreadable file */ }
    });
    if (closed) return;
    found = scored.sort((a, b) => a.score - b.score).slice(0, SHOW_LIMIT);
    status.textContent = found.length ? t('journey.nearbyFound', { count: found.length, scanned: photos.length }) : t('journey.nearbyNone', { scanned: photos.length });
    pick.disabled = false;
    grid.replaceChildren(...found.map(card));
  }

  function card(match) {
    const inputId = uid('jr-near');
    const image = el('img', { alt: '', hidden: true, decoding: 'async' });
    void puter.fs.read(match.item.path).then((blob) => {
      if (closed) return;
      match.blob = blob instanceof Blob ? blob : new Blob([blob]);
      const url = URL.createObjectURL(match.blob);
      urls.add(url);
      image.src = url; image.hidden = false;
    }).catch(() => {});
    return el('li.jr-nearby-item', {},
      el('input', { id: inputId, type: 'checkbox', onchange: (event) => { if (event.target.checked) chosen.add(match); else chosen.delete(match); update(); } }),
      el('label', { htmlFor: inputId }, el('span.jr-tile.is-loaded', {}, image), el('span.jr-nearby-name', {}, match.item.name),
        el('span.jr-muted', {}, [formatDate(match.exif.date), formatTime(match.exif.time)].filter(Boolean).join(' '))));
  }

  async function addChosen() {
    add.setAttribute('aria-busy', 'true');
    const files = [];
    for (const match of chosen) {
      try {
        const blob = match.blob ?? await puter.fs.read(match.item.path);
        files.push(new File([blob], match.item.name, { type: 'image/jpeg' }));
      } catch { /* skipped */ }
    }
    dialog.close('added');
    onAdd(files);
  }
  return dialog;
}
