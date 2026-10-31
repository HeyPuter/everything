// Shared pieces of the import and export dialogs.
import { createElement, Upload, Download, HardDrive, Route, FileJson, MapPin, CircleAlert } from 'lucide';
import { el } from '../../ui/dom.js';
import { icon as kitIcon } from '../../ui/icons.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { formatDate } from '../../lib/format.js';
import { canSaveToDrive, canUseDrive, chooseLocalFiles, pickFromDrive } from '../../lib/files/index.js';
import { IoError, errorKey } from '../../lib/io/errors.js';

const extra = { upload: Upload, download: Download, drive: HardDrive, track: Route, json: FileJson, waypoint: MapPin, alert: CircleAlert };
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}

/** `io.<base>One` / `io.<base>Other` with `{count}` formatted. */
export function plural(count, base, values = {}) {
  const form = new Intl.PluralRules('en').select(count) === 'one' ? 'One' : 'Other';
  return t(`io.${base}${form}`, { ...values, count: new Intl.NumberFormat(displayLocale()).format(count) });
}

export const errorText = (error) => t(errorKey(error));

/** What the dialogs need from a view context; any part may be missing. */
export function deps(context = {}) {
  const session = context.session ?? null;
  return {
    space: context.space ?? null,
    session,
    api: session?.api ?? null,
    puter: context.puter ?? globalThis.puter ?? null,
    personal: session?.personal ?? context.personal ?? null,
    uid: context.account?.uuid ?? session?.account?.uuid ?? context.space?.store?.uid ?? null,
    app: context.app ?? null,
  };
}

export const driveAvailable = (puter) => canSaveToDrive(puter);

/** Opens Puter's save picker. It never settles when dismissed, so callers must not wait on it to re-enable UI. */
export function saveToDrive(puter, blob, name) {
  if (!canSaveToDrive(puter)) throw new IoError('drive_unavailable');
  return puter.ui.showSaveFilePicker(blob, name);
}

/** The device file chooser; resolves to one File or null. */
export async function pickDeviceFile(accept) {
  const [file] = await chooseLocalFiles({ accept, multiple: false });
  return file ?? null;
}
export const pickerAvailable = (puter) => canUseDrive(puter);
export async function pickDriveFile(puter) {
  const [file] = await pickFromDrive({ multiple: false, puter });
  return file ?? null;
}

/** File bytes, refusing anything over `max` before reading it. */
export async function fileBytes(file, max) {
  if (!file || !(file.size > 0)) throw new IoError('file_empty');
  if (file.size > max) throw new IoError('file_too_large');
  return new Uint8Array(await file.arrayBuffer());
}

/** A stored color (day slot or `#rrggbb`) as `#rrggbb` for GPX and KML, read from the current theme's tokens. */
export function resolveColor(value) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (!Number.isInteger(value) || value < 1 || value > 8) return null;
  const token = getComputedStyle(document.documentElement).getPropertyValue(`--day-${value}`).trim();
  return /^#[0-9a-f]{6}$/i.test(token) ? token.toLowerCase() : null;
}

/** "Day 3 · Title · 4 Jun 2026" for a day entity at position `index`. */
export function dayLabel(day, index) {
  return [t('io.dayN', { n: index + 1 }), day.title, day.date && formatDate(day.date)].filter(Boolean).join(' · ');
}

/** A drop target that hands the first dropped file to `onFile`. */
export function dropZone(onFile, ...children) {
  const zone = el('div.io-drop', {}, ...children);
  const over = (event) => { if ([...(event.dataTransfer?.types ?? [])].includes('Files')) { event.preventDefault(); zone.classList.add('is-over'); } };
  zone.addEventListener('dragenter', over);
  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', (event) => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  return zone;
}

/** A status block with a progress bar and a live text line. */
export function progressBlock() {
  const text = el('p.io-progress-text', { role: 'status', 'aria-live': 'polite' });
  const bar = el('progress.meter.io-progress-bar', { max: 1, value: 0 });
  const node = el('div.io-progress', {}, bar, text);
  return {
    node,
    set(message, done = null, total = null) {
      text.textContent = message;
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) { bar.max = total; bar.value = Math.min(done, total); } else bar.removeAttribute('value');
    },
  };
}

/** A hidden error line with an optional retry button. */
export function errorLine() {
  const node = el('div.io-error', { role: 'alert', hidden: true });
  return {
    node,
    show(error, retry) {
      node.replaceChildren(icon('alert', 16), el('span', {}, typeof error === 'string' ? error : errorText(error)));
      if (retry) node.append(el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: retry }, t('io.retry')));
      node.hidden = false;
    },
    clear() { node.hidden = true; node.replaceChildren(); },
  };
}
