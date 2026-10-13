/**
 * Automate: the scripts a workbook carries. A script is JavaScript with an `async function main(workbook)` that
 * acts on the workbook through the API in script-runtime.js; it runs isolated from the app (see script-run.js and
 * lib/script-sandbox.js) and its changes are one undo step.
 *
 * Scripts travel with the file: in the app's own JSON (Workbook.toJSON) and in an .xlsx as a package part of their
 * own that other programs leave alone (see xlsx-scripts.js). Editing a script is not an undoable cell edit: like a
 * query, it marks the workbook changed so it saves, and announces 'scripts'.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const MAX_SCRIPTS = 200;
export const MAX_SCRIPT_CODE = 512 * 1024;
export const MAX_SCRIPT_NAME = 80;
const MAX_DESCRIPTION = 500;

const newId = () => (globalThis.crypto?.randomUUID?.() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** A script name problem in words, or null: names are not blank, not overlong, and unique ignoring case. */
export function scriptNameProblem(wb, name, exceptId = null) {
  const text = String(name ?? '').trim();
  if (!text) return 'Enter a name for the script';
  if (text.length > MAX_SCRIPT_NAME) return `A script name can be at most ${MAX_SCRIPT_NAME} characters`;
  if (/[\u0000-\u001f\\/:*?"<>|]/.test(text)) return 'A script name cannot contain \\ / : * ? " < > |';
  if ((wb?.scripts || []).some((s) => s.id !== exceptId && s.name.toLowerCase() === text.toLowerCase())) return `There is already a script named "${text}"`;
  return null;
}

/** `base`, else `base 2`, `base 3`… whichever the workbook does not use yet. */
export function uniqueScriptName(wb, base = 'Script') {
  const taken = new Set((wb?.scripts || []).map((s) => s.name.toLowerCase()));
  const stem = String(base).trim().slice(0, MAX_SCRIPT_NAME - 4) || 'Script';
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}

function normalizeScript(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_SCRIPT_NAME) : '';
  if (!name || typeof raw.code !== 'string' || raw.code.length > MAX_SCRIPT_CODE) return null;
  const time = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  return {
    id: typeof raw.id === 'string' && raw.id && raw.id.length <= 64 ? raw.id : newId(),
    name,
    code: raw.code,
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description.slice(0, MAX_DESCRIPTION) } : {}),
    ...(time(raw.created) ? { created: time(raw.created) } : {}),
    ...(time(raw.modified) ? { modified: time(raw.modified) } : {}),
  };
}

/** The scripts kept in a file, cleaned: unreadable entries dropped, names made unique, at most MAX_SCRIPTS. */
export function normalizeScripts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const names = new Set();
  const ids = new Set();
  for (const raw of list) {
    if (out.length >= MAX_SCRIPTS) break;
    const s = normalizeScript(raw);
    if (!s) continue;
    if (ids.has(s.id)) s.id = newId();
    let name = s.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${s.name} ${n}`;
    s.name = name;
    names.add(name.toLowerCase());
    ids.add(s.id);
    out.push(s);
  }
  return out;
}

/** The scripts as they are saved: a deep copy, nothing shared with the live list. */
export const serializeScripts = (wb) => (wb?.scripts || []).map((s) => ({ ...s }));

function changed(wb) {
  wb.dirty = true;
  wb.version++;
  wb._announce?.('scripts', null);
}

export const scriptById = (wb, id) => (wb?.scripts || []).find((s) => s.id === id) || null;
export const scriptByName = (wb, name) => (wb?.scripts || []).find((s) => s.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) || null;

/** Add a script; its name is made unique when taken. Returns the script, or null when the workbook holds the most it can. */
export function addScript(wb, { name = 'Script', code = '', description = '' } = {}) {
  if ((wb.scripts || []).length >= MAX_SCRIPTS) return null;
  const now = Date.now();
  const script = normalizeScript({ id: newId(), name: uniqueScriptName(wb, name), code, description, created: now, modified: now });
  if (!script) return null;
  wb.scripts = [...(wb.scripts || []), script];
  changed(wb);
  return script;
}

/** Change a script's name, code or description. A taken or blank name is refused (returns null). */
export function updateScript(wb, id, patch = {}) {
  const at = (wb.scripts || []).findIndex((s) => s.id === id);
  if (at < 0) return null;
  const old = wb.scripts[at];
  if (patch.name != null && scriptNameProblem(wb, patch.name, id)) return null;
  const next = normalizeScript({ ...old, ...patch, name: patch.name != null ? String(patch.name).trim() : old.name, modified: Date.now() });
  if (!next) return null;
  if (next.name === old.name && next.code === old.code && (next.description || '') === (old.description || '')) return old;
  const list = [...wb.scripts];
  list[at] = next;
  wb.scripts = list;
  changed(wb);
  return next;
}

export function deleteScript(wb, id) {
  const before = (wb.scripts || []).length;
  wb.scripts = (wb.scripts || []).filter((s) => s.id !== id);
  if (wb.scripts.length !== before) changed(wb);
}

export function duplicateScript(wb, id) {
  const s = scriptById(wb, id);
  return s ? addScript(wb, { name: `${s.name} copy`, code: s.code, description: s.description }) : null;
}

/** A script's code as a fingerprint (hex SHA-256), by which the user's trust in it is remembered. */
export function scriptFingerprint(code) {
  const bytes = sha256(new TextEncoder().encode(String(code ?? '')));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The skeleton of a new script. */
export const NEW_SCRIPT_CODE = `/**
 * Runs when you press Run. \`workbook\` is the open workbook.
 * Reading cells is asynchronous: await getValues(), getFormulas() and the like.
 */
async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const range = workbook.getSelectedRange();
  const values = await range.getValues();
  console.log(\`\${range.getAddress()} holds \${values.length} row(s).\`);
}
`;

/**
 * The script gallery's samples: each a ready-to-run script, written against the public API only, so it is also an
 * example to learn from. `id` is stable (the gallery and the ribbon refer to samples by it).
 */
export const SAMPLE_SCRIPTS = [
  {
    id: 'highlight-duplicates',
    name: 'Highlight duplicates',
    description: 'Shades every value that appears more than once in the selection (or the whole sheet when a single cell is selected).',
    code: `/** Shade every value that appears more than once. */
async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  let range = workbook.getSelectedRange();
  if (range.getCellCount() === 1) range = await sheet.getUsedRange();
  if (!range) { console.log('The sheet is empty.'); return; }
  const values = await range.getValues();
  const seen = new Map();
  values.forEach((row, r) => row.forEach((value, c) => {
    if (value === null || value === '') return;
    const key = typeof value === 'string' ? value.trim().toLowerCase() : String(value);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push([r, c]);
  }));
  let count = 0;
  for (const cells of seen.values()) {
    if (cells.length < 2) continue;
    for (const [r, c] of cells) {
      range.getCell(r, c).getFormat().getFill().setColor('#fde68a');
      count++;
    }
  }
  console.log(count ? \`Highlighted \${count} duplicate cell(s).\` : 'No duplicates found.');
}
`,
  },
  {
    id: 'unhide-everything',
    name: 'Unhide everything',
    description: 'Shows every hidden sheet, row and column in the workbook.',
    code: `/** Show every hidden sheet, row and column. */
async function main(workbook) {
  for (const sheet of workbook.getWorksheets()) {
    if (!sheet.getVisible()) sheet.setVisible(true);
    const all = sheet.getRange();
    all.setRowsHidden(false);
    all.setColumnsHidden(false);
  }
  console.log(\`Checked \${workbook.getWorksheets().length} sheet(s).\`);
}
`,
  },
  {
    id: 'sum-each-column',
    name: 'Sum each column',
    description: 'Adds a bold Total row under the data with a SUM for every column that holds numbers.',
    code: `/** Add a Total row under the data, summing every column of numbers. */
async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const used = await sheet.getUsedRange();
  if (!used) { console.log('The sheet is empty.'); return; }
  const values = await used.getValues();
  const first = used.getCell(0, 0);
  const totalRow = used.getRowCount();
  const formulas = [];
  for (let c = 0; c < used.getColumnCount(); c++) {
    const numbers = values.slice(1).some((row) => typeof row[c] === 'number');
    const column = used.getColumn(c);
    const top = column.getCell(1, 0).getAddress({ sheet: false });
    const bottom = column.getCell(totalRow - 1, 0).getAddress({ sheet: false });
    formulas.push(numbers ? \`=SUM(\${top}:\${bottom})\` : c === 0 ? 'Total' : '');
  }
  const totals = first.getOffsetRange(totalRow, 0).getResizedRange(0, formulas.length - 1);
  totals.setFormulas([formulas]);
  totals.getFormat().getFont().setBold(true);
  totals.getFormat().setBorder('top', { style: 'double' });
  console.log(\`Totals written to \${totals.getAddress()}.\`);
}
`,
  },
  {
    id: 'table-of-contents',
    name: 'Make a table of contents',
    description: 'Adds a Contents sheet at the front listing every sheet, each name a link to it.',
    code: `/** Build (or rebuild) a Contents sheet that links to every other sheet. */
async function main(workbook) {
  const name = 'Contents';
  let contents = workbook.getWorksheet(name);
  if (contents) contents.getRange().clear();
  else contents = workbook.addWorksheet(name, 0);
  const rows = [['Sheet', 'Visible']];
  for (const sheet of workbook.getWorksheets()) {
    if (sheet.getName() === name) continue;
    const target = "'" + sheet.getName().replace(/'/g, "''") + "'!A1";
    rows.push([\`=HYPERLINK("#\${target}", "\${sheet.getName().replace(/"/g, '""')}")\`, sheet.getVisible() ? 'Yes' : 'No']);
  }
  const range = contents.getRange('A1').getResizedRange(rows.length - 1, 1);
  range.setFormulas(rows);
  contents.getRange('A1:B1').getFormat().getFont().setBold(true);
  contents.getRange('A1:B1').getFormat().getFill().setColor('#dbeafe');
  contents.getRange('A:A').getFormat().setColumnWidth(220);
  contents.activate();
  console.log(\`Listed \${rows.length - 1} sheet(s).\`);
}
`,
  },
  {
    id: 'header-row',
    name: 'Style and freeze the header row',
    description: 'Makes the first row of the data bold with a fill and a bottom border, and freezes it in place.',
    code: `/** Bold, shade and freeze the first row of the active sheet's data. */
async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const used = await sheet.getUsedRange();
  if (!used) { console.log('The sheet is empty.'); return; }
  const header = used.getRow(0);
  const format = header.getFormat();
  format.getFont().setBold(true);
  format.getFill().setColor('#e2e8f0');
  format.setBorder('bottom', { style: 'medium' });
  sheet.freezeRows(used.getRowIndex() + 1);
  console.log(\`Styled \${header.getAddress()} and froze it.\`);
}
`,
  },
  {
    id: 'remove-blank-rows',
    name: 'Remove blank rows',
    description: 'Deletes every completely empty row inside the data of the active sheet.',
    code: `/** Delete the rows of the data that hold nothing at all. */
async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const used = await sheet.getUsedRange();
  if (!used) { console.log('The sheet is empty.'); return; }
  const values = await used.getValues();
  let removed = 0;
  // From the bottom up, so each deletion leaves the rows still to check where they were.
  for (let r = values.length - 1; r >= 0; r--) {
    if (values[r].every((v) => v === null || v === '')) {
      used.getRow(r).getEntireRow().delete();
      removed++;
    }
  }
  console.log(removed ? \`Removed \${removed} blank row(s).\` : 'No blank rows.');
}
`,
  },
];

export const sampleById = (id) => SAMPLE_SCRIPTS.find((s) => s.id === id) || null;
