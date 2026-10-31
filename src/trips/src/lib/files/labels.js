import { t } from '../i18n/index.js';
import { formatDate } from '../format.js';

/** Entity types a member can link a file to from the UI, in display order. */
export const LINKABLE = Object.freeze(['res', 'place', 'visit', 'exp', 'note']);

function visitLabel(space, visit) {
  const name = visit.title || space.get('place', visit.placeId)?.name || t('files.link.untitled');
  const day = space.get('day', visit.dayId);
  return day?.date ? t('files.link.visitOn', { name, date: formatDate(day.date, { style: 'medium' }) }) : name;
}

/** Display text for one link target; deleted targets read as such. */
export function linkLabel(space, link) {
  if (link.t === 'meta') return t('files.link.cover');
  if (link.t === 'msg') return t('files.link.message');
  const entity = space.get(link.t, link.id);
  if (!entity) return t('files.link.missing');
  if (link.t === 'visit') return visitLabel(space, entity);
  return entity.name || entity.title || t('files.link.untitled');
}

export const typeLabel = (type) => t(`files.linkType.${type}`);

/** Linkable entities of every type, `{t, id, label}`, filtered by a search string. */
export function linkCandidates(space, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  const out = [];
  for (const type of LINKABLE) {
    for (const entity of space.select[type]?.all() ?? []) {
      const label = linkLabel(space, { t: type, id: entity.id });
      if (!needle || label.toLocaleLowerCase().includes(needle)) out.push({ t: type, id: entity.id, label });
    }
  }
  return out;
}
