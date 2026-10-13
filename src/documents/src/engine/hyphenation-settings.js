/**
 * The document's hyphenation settings (§17.15.1.10 autoHyphenation, §17.15.1.21
 * consecutiveHyphenLimit, §17.15.1.37 doNotHyphenateCaps, §17.15.1.53 hyphenationZone).
 * They are document-wide: page settings carry them, but section breaks never change them.
 */
export const HYPHENATION_DEFAULTS = Object.freeze({ autoHyphenation: false, doNotHyphenateCaps: false, hyphenationZone: 360, consecutiveHyphenLimit: 0 });
export const HYPHENATION_KEYS = Object.freeze(Object.keys(HYPHENATION_DEFAULTS));

export function checkedHyphenationSetting(key, value) {
  if (key === 'autoHyphenation' || key === 'doNotHyphenateCaps') {
    if (typeof value !== 'boolean') throw new Error('Hyphenation options must be on or off.');
  } else if (key === 'hyphenationZone') {
    if (!Number.isInteger(value) || value < 0 || value > 31680) throw new Error('The hyphenation zone must be from 0 to 22 inches.');
  } else if (key === 'consecutiveHyphenLimit') {
    if (!Number.isInteger(value) || value < 0 || value > 32767) throw new Error('Limit consecutive hyphens to a whole number from 0 (no limit) to 32767.');
  } else throw new Error('Unknown hyphenation setting.');
  return value;
}

/** Layout geometry: the zone in CSS pixels, as page margins are. */
export function hyphenationGeometry(settings) {
  return { autoHyphenation: !!settings.autoHyphenation, doNotHyphenateCaps: !!settings.doNotHyphenateCaps,
    hyphenationZone: (settings.hyphenationZone ?? 360) / 15, consecutiveHyphenLimit: settings.consecutiveHyphenLimit || 0 };
}

/** The hyphenation keys of page settings or page geometry, for copying across sections. */
export function hyphenationOf(page) {
  return Object.fromEntries(HYPHENATION_KEYS.filter(key => key in page).map(key => [key, page[key]]));
}

/** Settings without the document-wide hyphenation keys, for comparing section geometry. */
export function withoutHyphenation(settings) {
  const result = { ...settings };
  for (const key of HYPHENATION_KEYS) delete result[key];
  return result;
}

/**
 * Change hyphenation settings as one model transaction (undoable, saved on export). Unlike other
 * page settings they apply to every section, so documents with several sections can change them.
 */
export function setHyphenationSettings(model, patch) {
  const next = { ...model.pageSettings };
  for (const [key, value] of Object.entries(patch)) next[key] = checkedHyphenationSetting(key, value);
  if (HYPHENATION_KEYS.every(key => next[key] === model.pageSettings[key])) return false;
  model.checkpoint();
  model.pageSettings = next;
  model.didChange();
  return true;
}
