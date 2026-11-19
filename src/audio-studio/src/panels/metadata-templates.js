// Metadata templates: named sets of metadata fields (station, originator,
// copyright, artist...) saved in the `metaTemplates` preference and applied
// to a file in one undoable step. Fields that identify one recording (title,
// track number, UMID, time reference, the session link) are never part of a template.

import { cleanMeta } from '../audio/meta.js';

/** Fields a template leaves out: they belong to one file only. */
export const PER_FILE_FIELDS = ['title', 'track', 'bextUmid', 'bextTimeRef', 'editOriginal'];

export const metaTemplates = (prefs) => (Array.isArray(prefs.get('metaTemplates')) ? prefs.get('metaTemplates').filter((t) => t && typeof t.name === 'string' && t.meta) : []);

/** The template fields of `meta` (cleaned, per-file fields removed). */
export function templateFields(meta) {
  const m = cleanMeta(meta);
  for (const id of PER_FILE_FIELDS) delete m[id];
  return m;
}

/** Saves `meta` as template `name`, replacing one with that name (any case). Returns the list. */
export function saveMetaTemplate(prefs, name, meta) {
  const n = String(name).trim();
  const list = metaTemplates(prefs).filter((t) => t.name.toLowerCase() !== n.toLowerCase());
  const next = [...list, { name: n, meta: templateFields(meta) }].sort((a, b) => a.name.localeCompare(b.name));
  prefs.set('metaTemplates', next);
  return next;
}

export function deleteMetaTemplate(prefs, name) {
  prefs.set('metaTemplates', metaTemplates(prefs).filter((t) => t.name !== name));
}

/**
 * Metadata after applying a template: its fields replace the file's; with `replace`, fields
 * the template does not have are cleared too (per-file fields are always kept).
 */
export function applyMetaTemplate(meta, template, { replace = false } = {}) {
  const keep = {};
  for (const id of PER_FILE_FIELDS) if (meta?.[id]) keep[id] = meta[id];
  return cleanMeta({ ...(replace ? {} : meta || {}), ...templateFields(template.meta), ...keep });
}
