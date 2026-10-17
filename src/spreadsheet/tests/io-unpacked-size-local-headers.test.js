import { expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// The unpacked-size guard read the sizes the central directory claims, but the reader unpacks
// each part by the size its local header claims, so a directory saying 1,000 bytes let a part
// whose header said 600 MB through to be unpacked whole; and a header that leaves its sizes to a
// data descriptor (as streaming writers do) was unpacked without any bound at all.

async function parts() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Amount');
  wb.setInput(id, 1, 0, '5');
  const zip = XLSX.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  return zip.FullPaths.map((path, i) => [path.slice(zip.FullPaths[0].length), zip.FileIndex[i]])
    .filter(([name, entry]) => name && entry.type === 2).map(([name, entry]) => ({ name, data: new Uint8Array(entry.content) }));
}

/**
 * A zip of `entries`, written as a streaming writer does when `streamed` (flag 8, zero sizes in the
 * local header, a data descriptor after the data); `claim(entry)` overrides what the directory and
 * the local header say an entry unpacks to.
 */
function zip(entries, { streamed = false, claim = () => ({}) } = {}) {
  const chunks = [], directory = [];
  let offset = 0;
  const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name), packed = deflateRawSync(entry.data);
    const { local = entry.data.length, central = entry.data.length } = claim(entry);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, streamed ? 8 : 0, true);
    header.setUint16(8, 8, true); header.setUint32(18, streamed ? 0 : packed.length, true); header.setUint32(22, streamed ? 0 : local, true);
    header.setUint16(26, name.length, true);
    const at = offset;
    push(new Uint8Array(header.buffer)); push(name); push(packed);
    if (streamed) {
      const descriptor = new DataView(new ArrayBuffer(16));
      descriptor.setUint32(0, 0x08074b50, true); descriptor.setUint32(8, packed.length, true); descriptor.setUint32(12, entry.data.length, true);
      push(new Uint8Array(descriptor.buffer));
    }
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true); record.setUint16(8, streamed ? 8 : 0, true);
    record.setUint16(10, 8, true); record.setUint32(20, packed.length, true); record.setUint32(24, central, true);
    record.setUint16(28, name.length, true); record.setUint32(42, at, true);
    directory.push(new Uint8Array(record.buffer), name);
  }
  const start = offset;
  for (const bytes of directory) push(bytes);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - start, true); end.setUint32(16, start, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let p = 0;
  for (const bytes of chunks) { out.set(bytes, p); p += bytes.length; }
  return out;
}

it('refuses a part whose local header claims past the limit while the directory claims little', async () => {
  const bomb = zip(await parts(), { claim: (e) => (e.name === 'xl/worksheets/sheet1.xml' ? { local: 600 * 1024 * 1024, central: 1000 } : {}) });
  await expect(workbookFromFile(bomb, 'bomb.xlsx')).rejects.toMatchObject({ code: 'too-large' });
});

it('refuses a part with data that claims to unpack to nothing in both places', async () => {
  const blob = { name: 'xl/media/blob.bin', data: new Uint8Array(4096) };
  const bomb = zip([...await parts(), blob], { streamed: true, claim: (e) => (e === blob ? { central: 0 } : {}) });
  await expect(workbookFromFile(bomb, 'bomb.xlsx')).rejects.toMatchObject({ code: 'too-large' });
});

it('unpacks a streamed part no further than the directory says', () => {
  const blob = { name: 'blob.bin', data: new Uint8Array(1024 * 1024).fill(7) };
  const read = XLSX.CFB.read(zip([blob], { streamed: true, claim: () => ({ central: 1000 }) }), { type: 'array', WTF: false });
  expect(XLSX.CFB.find(read, 'blob.bin').content.length).toBe(1000);
});

it('opens a file whose parts are streamed with data descriptors, and an ordinary one', async () => {
  for (const streamed of [true, false]) {
    const back = await workbookFromFile(zip(await parts(), { streamed }), 'fine.xlsx');
    expect(back.getValue(back.activeSheetId, 0, 0)).toBe('Amount');
    expect(back.getValue(back.activeSheetId, 1, 0)).toBe(5);
  }
});
