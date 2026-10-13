import { describe, it, expect } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookToOds, workbookFromFile } from '../src/core/io.js';
import { addScript, updateScript, deleteScript, duplicateScript, normalizeScripts, scriptNameProblem, uniqueScriptName, scriptFingerprint } from '../src/core/scripts.js';
import { SCRIPTS_PART, SCRIPTS_RELATIONSHIP } from '../src/core/xlsx-scripts.js';
import { addScriptButton, scriptOfLink } from '../src/ui/automate.js';

const CODE = 'async function main(workbook) {\n  console.log("héllo \\u2028 ✓");\n}\n';
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
/** The parts of a zip by path (no leading slash), and their text. */
function unzipSync(data) {
  const zip = X.CFB.read(data, { type: 'array' });
  const out = {};
  zip.FullPaths.forEach((path, i) => { if (zip.FileIndex[i].type === 2) out[path.replace(/^[^/]*\//, '')] = zip.FileIndex[i].content; });
  return out;
}
const strFromU8 = (u8) => new TextDecoder().decode(u8);

describe('workbook scripts', () => {
  it('adds, renames, duplicates and deletes scripts, outside the undo history', () => {
    const wb = new Workbook();
    const events = [];
    wb.addEventListener('change', (e) => events.push(e.detail.type));
    const s = addScript(wb, { name: 'Tidy', code: CODE });
    expect(addScript(wb, { name: 'tidy' }).name).toBe('tidy 2');
    expect(scriptNameProblem(wb, 'TIDY')).toMatch(/already/);
    expect(scriptNameProblem(wb, 'a/b')).toMatch(/cannot contain/);
    expect(updateScript(wb, s.id, { name: 'tidy 2' })).toBe(null);
    expect(updateScript(wb, s.id, { name: 'Clean', code: '// new' }).code).toBe('// new');
    expect(duplicateScript(wb, s.id).name).toBe('Clean copy');
    deleteScript(wb, s.id);
    expect(wb.scripts.map((x) => x.name)).toEqual(['tidy 2', 'Clean copy']);
    expect(wb.dirty).toBe(true);
    expect(wb.canUndo()).toBe(false);
    expect(events).toContain('scripts');
    expect(uniqueScriptName(wb, 'Clean copy')).toBe('Clean copy 2');
  });

  it('cleans what a file says: junk dropped, names made unique, ids kept', () => {
    const list = normalizeScripts([{ name: 'A', code: '1', id: 'x' }, { name: 'a', code: '2', id: 'x' }, { name: '', code: '3' }, { name: 'B' }, null, 'text']);
    expect(list.map((s) => s.name)).toEqual(['A', 'a 2']);
    expect(list[0].id).toBe('x');
    expect(list[1].id).not.toBe('x');
  });

  it('fingerprints code', () => {
    expect(scriptFingerprint('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(scriptFingerprint('a')).not.toBe(scriptFingerprint('b'));
  });

  it('keeps scripts in the app format', () => {
    const wb = new Workbook();
    addScript(wb, { name: 'One', code: CODE, description: 'First' });
    const copy = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(copy.scripts).toEqual(wb.scripts);
    expect(new Workbook().toJSON().scripts).toBeUndefined();
  });

  it('keeps scripts in an .xlsx part of their own that other programs can ignore', async () => {
    const wb = new Workbook();
    wb.setInput(wb.activeSheetId, 0, 0, '42');
    addScript(wb, { name: 'One', code: CODE });
    addScript(wb, { name: 'Two', code: '// two' });
    const file = await bytes(await workbookToXlsx(wb));
    const zip = unzipSync(file);
    expect(Object.keys(zip)).toContain(SCRIPTS_PART.slice(1));
    expect(strFromU8(zip['_rels/.rels'])).toContain(SCRIPTS_RELATIONSHIP);
    expect(strFromU8(zip['[Content_Types].xml'])).toContain(`PartName="${SCRIPTS_PART}"`);
    // Nothing of the scripts is in the parts every spreadsheet program reads.
    expect(strFromU8(zip['xl/workbook.xml'])).not.toContain('main(workbook)');
    const reopened = await workbookFromFile(file, 'book.xlsx');
    expect(reopened.scripts.map((s) => [s.name, s.code])).toEqual([['One', CODE], ['Two', '// two']]);
    expect(reopened.getValue(reopened.activeSheetId, 0, 0)).toBe(42);
    // Saved again, they are written again, once.
    const again = unzipSync(await bytes(await workbookToXlsx(reopened)));
    expect(strFromU8(again['_rels/.rels']).split(SCRIPTS_RELATIONSHIP).length).toBe(2);
  });

  it('writes no scripts part for a workbook without scripts', async () => {
    const zip = unzipSync(await bytes(await workbookToXlsx(new Workbook())));
    expect(Object.keys(zip)).not.toContain(SCRIPTS_PART.slice(1));
    expect(strFromU8(zip['_rels/.rels'])).not.toContain(SCRIPTS_RELATIONSHIP);
  });

  it('keeps scripts in an .ods', async () => {
    const wb = new Workbook();
    addScript(wb, { name: 'One', code: CODE });
    const reopened = await workbookFromFile(await bytes(await workbookToOds(wb)), 'book.ods');
    expect(reopened.scripts.map((s) => [s.name, s.code])).toEqual([['One', CODE]]);
  });

  it('keeps a script button and its link through an .xlsx', async () => {
    const wb = new Workbook();
    addScript(wb, { name: 'Tidy up', code: '// x' });
    addScriptButton(wb, wb.activeSheetId, { r: 1, c: 1 }, 'Tidy up');
    const back = await workbookFromFile(await bytes(await workbookToXlsx(wb)), 'b.xlsx');
    const drawn = back.sheets[0].charts.find((c) => c.type === 'text');
    expect(drawn.text).toBe('Tidy up');
    expect(scriptOfLink(drawn.hyperlink)).toBe('Tidy up');
  });
});
