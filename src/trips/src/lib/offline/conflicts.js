import { openConflictDialog, conflictList } from '../../ui/conflict.js';
import { t } from '../i18n/index.js';

const TYPES = new Set(['meta', 'member', 'day', 'place', 'visit', 'dayNote', 'res', 'exp', 'settle', 'splitPreset', 'costCat', 'pack', 'bag', 'todo',
  'listMeta', 'note', 'link', 'poll', 'msg', 'file', 'cat', 'guest', 'via', 'dayEnd', 'dayTrack']);
const FIELDS = new Set(['name', 'title', 'notes', 'desc', 'description', 'text', 'body', 'address', 'date', 'start', 'end', 'time', 'amount',
  'currency', 'status', 'type', 'code', 'cat', 'tags', 'rating', 'visited', 'order', 'dayId', 'placeId', 'url', 'web', 'phone', 'qty', 'done',
  'due', 'who', 'payers', 'split', 'price', 'color', 'icon', 'location', 'legs', 'people', 'dwell', 'pinned', 'question', 'options']);

/** Translated entity type, for conflict dialogs and lists. */
export const typeLabel = (type) => (TYPES.has(type) ? t(`offline.type.${type}`) : t('offline.type.item'));
/** Translated field name; unknown fields read as "another detail". */
export const fieldLabel = (_type, field) => (FIELDS.has(field) ? t(`offline.field.${field}`) : t('offline.field.other'));

/** `{type, name}` for `conflictList`. Names come from the user's or the server's copy and render as text. */
export function describeConflict(conflict) {
  const type = conflict.op?.do ? t('conflict.change') : typeLabel(conflict.op?.t);
  const source = conflict.local ?? conflict.server ?? conflict.op?.put ?? {};
  const name = [source.name, source.title, source.question].find((value) => typeof value === 'string' && value.trim());
  return { type, name: name ? name.slice(0, 120) : '' };
}

/** Opens the Keep mine / Keep theirs / Merge dialog for a parked conflict; `resolve(choice)` applies it. */
export function openConflict({ conflict, resolve }) {
  return openConflictDialog({ conflict, typeLabel, fieldLabel, onResolve: resolve });
}

export function conflictListFor({ conflicts, onOpen, formatTime }) {
  return conflictList({ conflicts, describe: describeConflict, onOpen, formatTime });
}
