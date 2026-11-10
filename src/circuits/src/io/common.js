// Helpers shared by the exporters.

/** Looks up a component definition in a library given as a Map or a plain object. */
export function defOf(library, id) {
  if (!library || id == null) return null;
  if (library instanceof Map) return library.get(id) ?? null;
  return library[id] ?? null;
}

/** Pour fill polygon set for a pour id from a Map or plain object. */
export function fillOf(pourFills, id) {
  if (!pourFills) return null;
  if (pourFills instanceof Map) return pourFills.get(id) ?? null;
  return pourFills[id] ?? null;
}

/** File-name-safe base name: 'My Board.pcb' -> 'My_Board'. */
export function baseName(name, fallback = 'board') {
  const s = String(name || '').replace(/\.[^.]*$/, '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || fallback;
}

/** Millimetres with fixed decimals and trailing zeros trimmed: 1.500000 -> '1.5'. */
export function mmStr(nm, decimals = 6) {
  let s = (nm / 1e6).toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Natural sort for designators: R2 before R10. */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Spreadsheets run a field as a formula when it starts with any of these.
const FORMULA_START = /^[=@+\-\t\r]/;
// ...except signed numbers and values (-5.08, +3V3, -12V), which stay text.
const SIGNED_VALUE = /^[+-](\d[\d.]*[A-Za-zµΩ%°]*\d*)?$/;

/** One CSV field: quoted when needed, quotes doubled, formula-like text neutralised. */
export function csvField(value) {
  let s = value == null ? '' : String(value);
  if (FORMULA_START.test(s) && !SIGNED_VALUE.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Rows of arrays to CSV text with CRLF line endings. */
export function csvRows(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export const schDocs = (project) => (project?.documents || []).filter((d) => d.kind === 'sch');
export const pcbDocs = (project) => (project?.documents || []).filter((d) => d.kind === 'pcb');
