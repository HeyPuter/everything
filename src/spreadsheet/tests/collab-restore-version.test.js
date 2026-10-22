import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';
import { listVersions } from '../src/lib/versions.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

// The owner of a shared workbook can restore an earlier version of its file. The snapshot is a file read back, which
// gives every sheet a new id, so the restore went to the others as every sheet deleted and new ones put in: they could
// not delete the last sheet before the new ones came, and kept it beside the restored sheets, renamed "Sheet1 (2)"
// to make room, while the owner saw the version alone. The restored sheets now keep the ids of the sheets they
// replace, and reach the others as changes to the sheets they have.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); installMockPuter(); });
afterEach(() => { delete globalThis.puter; });

const shown = (wb) => wb.sheets.map((s) => `${s.name}: ${wb.getValue(s.id, 0, 0)}`);

it('sends a restored version to the others as the same sheets, holding what the version holds', async () => {
  const doc = new Doc({ wb: new Workbook({ sheets: [{ name: 'Sales' }, { name: 'Notes' }] }), name: 'Book' });
  const [sales, notes] = doc.wb.sheets.map((s) => s.id);
  doc.wb.setInput(sales, 0, 0, 'then');
  doc.wb.setInput(notes, 0, 0, '=Sales!A1');
  await doc.save();
  await doc.saveVersion('kept');
  doc.wb.setInput(sales, 0, 0, 'now');
  await doc.save();
  // From here the workbook is shared: another copy holds what this one holds.
  const other = new Workbook(doc.wb.toJSON());
  const mine = new Replica(doc.wb), theirs = new Replica(other);
  const [kept] = (await listVersions(doc.file)).filter((v) => v.label === 'kept');
  await doc.restoreVersion(kept.path);
  await null;
  expect(doc.wb.sheets.map((s) => s.id)).toEqual([sales, notes]);
  expect(shown(doc.wb)).toEqual(['Sales: then', 'Notes: then']);
  theirs.receive([{ rev: 1, user: 'owner', username: 'owner', changes: JSON.parse(JSON.stringify(mine.outgoing())) }]);
  expect(shown(other)).toEqual(['Sales: then', 'Notes: then']);
  doc.destroy();
});
