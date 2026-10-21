/**
 * A workbook's document properties (Excel's File ▸ Info: title, subject, author, tags, comments, category, company,
 * manager, the date it was created, and custom properties), kept from the file it was opened from and written back.
 *
 * properties = { core: { Title, Subject, ...: text, CreatedDate: ISO time }, custom: [{ name, value }] }
 *   a custom value is text, a finite number, true or false, or { date: ISO time }.
 */
const TEXT_KEYS = ['Title', 'Subject', 'Author', 'Keywords', 'Comments', 'Category', 'ContentStatus', 'Manager', 'Company'];
const MAX_TEXT = 32767, MAX_CUSTOM = 1000, MAX_NAME = 255;

const isoTime = (value) => {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const customValue = (value) => {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  const date = value instanceof Date ? isoTime(value) : value && typeof value === 'object' ? isoTime(value.date) : null;
  return date ? { date } : null;
};

/** The properties as the app keeps them, or null when there are none. */
export function normalizeDocumentProperties(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const core = {};
  for (const key of TEXT_KEYS) if (typeof raw.core?.[key] === 'string' && raw.core[key]) core[key] = raw.core[key].slice(0, MAX_TEXT);
  const created = isoTime(raw.core?.CreatedDate);
  if (created) core.CreatedDate = created;
  const seen = new Set(), custom = [];
  for (const entry of Array.isArray(raw.custom) ? raw.custom.slice(0, MAX_CUSTOM) : []) {
    const name = typeof entry?.name === 'string' ? entry.name.slice(0, MAX_NAME) : '', value = customValue(entry?.value);
    if (!name || value == null || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    custom.push({ name, value });
  }
  return Object.keys(core).length || custom.length ? { ...(Object.keys(core).length ? { core } : {}), ...(custom.length ? { custom } : {}) } : null;
}

/** A SheetJS book's properties (Props, Custprops) as the app keeps them. */
export function readDocumentProperties(book) {
  return normalizeDocumentProperties({ core: book?.Props || {},
    custom: Object.entries(book?.Custprops || {}).map(([name, value]) => ({ name, value })) });
}

/** The properties onto a SheetJS book for its writer. */
export function writeDocumentProperties(book, properties) {
  const p = normalizeDocumentProperties(properties);
  if (!p) return;
  if (p.core) book.Props = { ...p.core, ...(p.core.CreatedDate ? { CreatedDate: new Date(p.core.CreatedDate) } : {}) };
  if (p.custom) book.Custprops = Object.fromEntries(p.custom.map(({ name, value }) => [name, value?.date ? new Date(value.date) : value]));
}
