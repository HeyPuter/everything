// Auto-fill: pages for a photo book from a journey's written entries and their photos.
import { BOOK_LIMITS } from './constants.js';
import { applyLayout, autoLayout, isEmptyPhoto, round } from './model.js';

const BODY_CHARS = 1200;
const FIRST_CHUNK = 4;
const CHUNK = 8;

/** Markdown story as plain text for a text box: no markup, links as their words, lists as bullets. */
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts text at a word boundary with an ellipsis. */
export function clip(text, max = BODY_CHARS) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `[{date, entries, photos: [{file, entry}], title, body}]` per day, skipping what the book already holds. */
export function dayStories(entries, { isPhoto = () => true, used = new Set(), usedEntries = new Set(), formatDate = (date) => date } = {}) {
  const days = [];
  const seen = new Set(used);
  for (const entry of entries) {
    let day = days.at(-1);
    if (day?.date !== entry.date) { day = { date: entry.date, entries: [], photos: [] }; days.push(day); }
    day.entries.push(entry);
    for (const file of entry.media ?? []) {
      if (seen.has(file) || !isPhoto(file)) continue;
      seen.add(file);
      day.photos.push({ file, entry: entry.id });
    }
  }
  return days.filter((day) => day.photos.length || day.entries.some((entry) => !usedEntries.has(entry.id))).map((day) => {
    const lead = day.entries.find((entry) => entry.type === 'day') ?? day.entries[0];
    const stories = day.entries.filter((entry) => plainText(entry.story));
    const body = stories.length === 1 && stories[0] === lead ? plainText(lead.story)
      : stories.map((entry) => `${entry.title}\n${plainText(entry.story)}`).join('\n\n');
    return { ...day, lead, title: `${formatDate(day.date)} · ${lead.title}`, body: clip(body), textUsed: usedEntries.has(lead.id) };
  });
}

const textEl = (text, style, extra = {}) => ({ k: 'text', text, style, x: 0, y: 0, w: 0.5, h: 0.1, z: 1, ...extra });
const photoEl = ({ file, entry }, z) => ({ k: 'photo', file, ...(entry ? { entry } : {}), fit: 'fill', x: 0, y: 0, w: 0.5, h: 0.5, z });

function elements(list, makeId) {
  return Object.fromEntries(list.map((item) => [makeId(), item]));
}

/** Spreads for days: the first spread of a day carries its title and story, later ones only photos. */
export function storySpreads(days, { book, makeId, room = BOOK_LIMITS.spreads, variant = 0 }) {
  const spreads = [];
  for (const day of days) {
    const chunks = day.photos.length <= 6 ? [day.photos] : [day.photos.slice(0, FIRST_CHUNK)];
    for (let index = FIRST_CHUNK; day.photos.length > 6 && index < day.photos.length; index += CHUNK) chunks.push(day.photos.slice(index, index + CHUNK));
    chunks.forEach((photos, index) => {
      if (spreads.length >= room) return;
      const list = photos.map((item, position) => photoEl(item, position + 1));
      if (index === 0 && !day.textUsed) {
        list.push(textEl(day.title, 'title', { entry: day.lead.id }));
        if (day.body) list.push(textEl(day.body, 'body', { entry: day.lead.id }));
      }
      const page = { kind: 'spread', els: elements(list, makeId) };
      spreads.push(autoLayout(page, { book, makeId, variant: variant + spreads.length }));
    });
  }
  return spreads;
}

/** Cover, first page, last page and back cover for a new book. */
export function singlePages({ meta = {}, book, makeId, coverFile = null, range = '', located = false }) {
  const title = meta.title ?? '';
  const subtitle = meta.subtitle || range;
  const cover = { kind: 'cover', els: elements([
    ...(coverFile ? [photoEl({ file: coverFile }, 1)] : []),
    textEl(title, 'title', { z: 2 }), ...(subtitle ? [textEl(subtitle, 'subtitle', { z: 3 })] : []),
  ], makeId) };
  const first = applyLayout({ kind: 'first', els: elements([textEl(title, 'title'), ...(range ? [textEl(range, 'subtitle', { z: 2 })] : [])], makeId) }, 'cover-type', { book, makeId });
  first.els = Object.fromEntries(Object.entries(first.els).filter(([, item]) => !isEmptyPhoto(item)));
  const last = { layout: null, els: elements([
    ...(located ? [{ k: 'map', scope: 'book', x: 0.08, y: 0.08, w: 0.84, h: 0.6, z: 1, fill: 'surface-2' }] : []),
    { k: 'stats', x: 0.08, y: located ? 0.72 : 0.3, w: 0.84, h: 0.2, z: 2, size: 11, align: 'center' },
  ], makeId) };
  const back = { layout: null, els: elements([textEl(title, 'caption', { x: 0.1, y: round(0.86), w: 0.8, h: 0.05, size: 8, align: 'center', color: 'ink-3' })], makeId) };
  return { cover: applyLayout(cover, coverFile ? 'cover-full' : 'cover-type', { book, makeId }), first, last, back };
}

/**
 * Everything a book filled from a journey needs: `{singles, spreads}`. `entries` are the written entries in story
 * order; `used`/`usedEntries` skip photos and entries the book already has (for "add the rest").
 */
export function autofillPlan({ entries, meta, book, makeId, isPhoto, coverFile, used, usedEntries, formatDate, range = '', room, variant = 0, singles = true }) {
  const days = dayStories(entries, { isPhoto, used, usedEntries, formatDate });
  const spreads = storySpreads(days, { book, makeId, room, variant });
  const located = entries.some((entry) => Number.isFinite(entry.loc?.lat) && Number.isFinite(entry.loc?.lng));
  const fallbackCover = coverFile ?? days.find((day) => day.photos.length)?.photos[0]?.file ?? null;
  return { spreads, singles: singles ? singlePages({ meta, book, makeId, coverFile: fallbackCover, range, located }) : null };
}
