// Validation of a section's line numbering (w:lnNumType, ECMA-376 §17.6.8).
// No imports: page-settings.js depends on it.
export const LINE_NUMBER_RESTARTS = Object.freeze(['newPage', 'newSection', 'continuous']);
/** The distance used when the section leaves it to the application ("Auto"), in twips: a quarter inch. */
export const AUTO_LINE_NUMBER_DISTANCE = 360;

/**
 * A section's line numbering: null (off) or { countBy, start, distance, restart }.
 * countBy shows every n-th number (1–100); start is the stored offset, so the first
 * number shown after a restart is start + 1; distance is twips from the text or null
 * for automatic; restart is newPage, newSection or continuous.
 */
export function checkedLineNumbers(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid line numbering.');
  for (const key of Object.keys(value)) if (!['countBy', 'start', 'distance', 'restart'].includes(key)) throw new Error('Unknown line numbering setting.');
  const { countBy = 1, start = 0, distance = null, restart = 'newPage' } = value;
  if (!Number.isSafeInteger(countBy) || countBy < 1 || countBy > 100) throw new Error('Count line numbers by a whole number from 1 to 100.');
  if (!Number.isSafeInteger(start) || start < 0 || start > 32766) throw new Error('Start line numbers at a whole number from 1 to 32767.');
  if (distance !== null && (!Number.isSafeInteger(distance) || distance < 0 || distance > 31680)) throw new Error('The distance from text must be from 0 to 22 inches.');
  if (!LINE_NUMBER_RESTARTS.includes(restart)) throw new Error('Unsupported line numbering restart.');
  return { countBy, start, distance, restart };
}

