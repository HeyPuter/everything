// File ↔ entity links. Writes use one path per link (`linked.<t>_<id>: true`), so links that members add at the same
// time are all kept. `links[]` is the older whole-list form: still read, and rewritten only to drop a link from it.
import { isId, isUuid } from './ids.js';

const TYPE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const sameLink = (a, b) => a.t === b.t && a.id === b.id;

export const linkKey = ({ t, id }) => `${t}_${id}`;

/** `{t, id}` from a `linked` key, or null. Types never contain `_`, so the first one splits it. */
export function parseLinkKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.indexOf('_');
  if (at < 1) return null;
  const t = key.slice(0, at);
  const id = key.slice(at + 1);
  return TYPE.test(t) && (isId(id) || isUuid(id) || id === 'meta') ? { t, id } : null;
}
export const isLinkKey = (key) => parseLinkKey(key) !== null;

/** Every link of a file in both forms, without duplicates: `[{t, id}]`. */
export function fileLinks(file) {
  const out = [];
  const seen = new Set();
  const add = (link) => {
    const key = linkKey(link);
    if (!seen.has(key)) { seen.add(key); out.push({ t: link.t, id: link.id }); }
  };
  for (const link of Array.isArray(file?.links) ? file.links : []) if (typeof link?.t === 'string' && typeof link?.id === 'string') add(link);
  for (const [key, on] of Object.entries(file?.linked ?? {})) {
    const link = on === true ? parseLinkKey(key) : null;
    if (link) add(link);
  }
  return out;
}

export function hasFileLink(file, target) {
  if (!file || !target) return false;
  return file.linked?.[linkKey(target)] === true || (Array.isArray(file.links) && file.links.some((link) => link && sameLink(link, target)));
}

/**
 * The patch adding and removing links on one file: paths under `linked`, plus a rewrite of the old `links[]` when it
 * holds a removed link. `{set?, unset?}`, or null when nothing changes.
 */
export function fileLinkPatch(file, { add = [], remove = [] } = {}) {
  const set = {};
  const unset = [];
  const drop = new Set(remove.map(linkKey));
  for (const link of add) {
    if (!drop.has(linkKey(link)) && !hasFileLink(file, link)) set[`linked.${linkKey(link)}`] = true;
  }
  for (const key of drop) if (file?.linked?.[key] !== undefined) unset.push(`linked.${key}`);
  const legacy = Array.isArray(file?.links) ? file.links : [];
  if (legacy.some((link) => drop.has(linkKey(link)))) {
    const rest = legacy.filter((link) => !drop.has(linkKey(link))).map(({ t, id }) => ({ t, id }));
    if (rest.length) set.links = rest; else unset.push('links');
  }
  if (!Object.keys(set).length && !unset.length) return null;
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}
