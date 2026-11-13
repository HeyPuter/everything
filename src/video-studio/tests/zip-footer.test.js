import { it, expect } from 'vitest';
import { zipBlobs, readZip } from '../src/storage/zip.js';

const expected = '{"name":"Keep this project"}';
async function archive({ force64 = false, comment = new Uint8Array(), trailer = new Uint8Array(), optional64 = false } = {}) {
  const zip = await zipBlobs([{ name: 'project.json', data: expected }], { force64 });
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer), end = bytes.length - 22;
  if (optional64) {
    const z64 = Number(view.getBigUint64(end - 12, true));
    view.setUint16(end + 8, 1, true);view.setUint16(end + 10, 1, true);
    view.setUint32(end + 12, Number(view.getBigUint64(z64 + 40, true)), true);
    view.setUint32(end + 16, Number(view.getBigUint64(z64 + 48, true)), true);
  }
  if (typeof comment === 'function') comment = comment(bytes, end);
  view.setUint16(end + 20, comment.length, true);
  return new Blob([bytes, comment, trailer]);
}
async function keepsProject(zip) {
  const entries = await readZip(zip);
  expect(entries.map(e => e.name)).toEqual(['project.json']);
  expect(await (await entries[0].blob()).text()).toBe(expected);
}

it.each([false, true])('ignores signature bytes in an ordinary comment (ZIP64 %s)', async force64 => {
  const comment = new Uint8Array(80).fill(65);new DataView(comment.buffer).setUint32(12, 0x06054b50, true);
  await keepsProject(await archive({ force64, comment }));
});

it.each([false, true])('ignores a complete empty-looking end record in a comment (ZIP64 %s)', async force64 => {
  const comment = new Uint8Array(22);new DataView(comment.buffer).setUint32(0, 0x06054b50, true);
  await keepsProject(await archive({ force64, comment }));
});

it.each([false, true])('ignores a copied end record inside the archive comment (ZIP64 %s)', async force64 => {
  await keepsProject(await archive({ force64, comment: (bytes, end) => bytes.slice(end) }));
});

it('skips an end record whose supposed directory is actually comment text', async () => {
  await keepsProject(await archive({ comment: (bytes) => {
    const comment = new Uint8Array(46 + 22).fill(65), view = new DataView(comment.buffer), end = 46;
    view.setUint32(end, 0x06054b50, true);view.setUint16(end + 4, 0, true);view.setUint16(end + 6, 0, true);
    view.setUint16(end + 8, 1, true);view.setUint16(end + 10, 1, true);view.setUint32(end + 12, 46, true);
    view.setUint32(end + 16, bytes.length, true);view.setUint16(end + 20, 0, true);
    return comment;
  } }));
});

it.each([false, true])('preserves support for trailing bytes after an archive (ZIP64 %s)', async force64 => {
  await keepsProject(await archive({ force64, trailer: new TextEncoder().encode('trailing bytes') }));
});

it('recognizes optional ZIP64 records when the ordinary footer fields still fit', async () => {
  await keepsProject(await archive({ force64: true, optional64: true }));
});

it('keeps comments and trailing bytes together readable', async () => {
  const comment = new Uint8Array(80).fill(65);new DataView(comment.buffer).setUint32(12, 0x06054b50, true);
  await keepsProject(await archive({ comment, trailer: new TextEncoder().encode('trailer') }));
});

it('keeps a central-directory digital signature readable', async () => {
  const zip = await archive(), bytes = new Uint8Array(await zip.arrayBuffer()), end = bytes.length - 22;
  const signature = new Uint8Array(9), sig = new DataView(signature.buffer);sig.setUint32(0, 0x05054b50, true);sig.setUint16(4, 3, true);signature.set([1,2,3],6);
  const footer = bytes.slice(end), view = new DataView(footer.buffer);view.setUint32(12, view.getUint32(12,true)+signature.length,true);
  await keepsProject(new Blob([bytes.slice(0,end),signature,footer]));
});

it('rejects a truncated archive comment', async () => {
  const zip = await archive({ comment: new Uint8Array(30).fill(65) });
  await expect(readZip(zip.slice(0, zip.size - 1))).rejects.toThrow(/damaged|incomplete/);
});

it.each([false, true])('does not add reads for an ordinary archive (ZIP64 %s)', async force64 => {
  const zip = await archive({ force64 });
  const ranges=[];
  const entries=await readZip({size:zip.size,slice(start,end){ranges.push([start,end]);return zip.slice(start,end);}});
  expect(entries).toHaveLength(1);
  expect(ranges).toEqual([[0,zip.size]]);
});


it('does not downgrade a structurally valid encrypted directory to an earlier candidate', async () => {
  const zip = await archive(), bytes = new Uint8Array(await zip.arrayBuffer()), view = new DataView(bytes.buffer);
  const cd = view.getUint32(bytes.length - 6,true);view.setUint16(cd + 8,view.getUint16(cd + 8,true)|1,true);
  await expect(readZip(new Blob([bytes]))).rejects.toThrow('Encrypted archives are not supported');
});

it('skips fake directory entries whose variable fields cross their declared boundary', async () => {
  await keepsProject(await archive({ comment: bytes => {
    const comment = new Uint8Array(46 + 22), view = new DataView(comment.buffer), end = 46;
    view.setUint32(0,0x02014b50,true);view.setUint16(28,100,true);
    view.setUint32(end,0x06054b50,true);view.setUint16(end+8,1,true);view.setUint16(end+10,1,true);
    view.setUint32(end+12,46,true);view.setUint32(end+16,bytes.length,true);
    return comment;
  } }));
});

it('rejects ZIP64 values beyond their declared extra-field payload', async () => {
  const zip = await archive({ force64: true }), bytes = new Uint8Array(await zip.arrayBuffer()), view = new DataView(bytes.buffer);
  const end = bytes.length-22,z64=Number(view.getBigUint64(end-12,true)),cd=Number(view.getBigUint64(z64+48,true));
  const extra = cd+46+view.getUint16(cd+28,true);view.setUint16(extra+2,0,true);
  await expect(readZip(new Blob([bytes]))).rejects.toThrow(/damaged/);
});

it('retains the original read failure if the file cannot be read', async () => {
  const zip = await archive({ force64: true, comment: new Uint8Array(65535).fill(65) });let reads=0;const failure = new Error('Temporary file read failure');
  await expect(readZip({size:zip.size,slice(start,end){if(++reads===2)throw failure;return zip.slice(start,end);}})).rejects.toBe(failure);
});

it('rejects an impossible directory size before reading a huge file as metadata', async () => {
  const size = 4 * 1024 ** 3, tail = new Uint8Array(22 + 65535), end = tail.length - 22;
  const view = new DataView(tail.buffer);view.setUint32(end,0x06054b50,true);view.setUint16(end+8,1,true);view.setUint16(end+10,1,true);
  view.setUint32(end+12,size-22,true);view.setUint32(end+16,0,true);
  const ranges=[];
  const zip = { size, slice(start,stop) {
    ranges.push([start,stop]);
    if (stop-start>tail.length) throw new Error('Forbidden large directory allocation');
    return new Blob([tail]);
  } };
  await expect(readZip(zip)).rejects.toThrow(/damaged/);
  expect(ranges).toEqual([[size-tail.length,size]]);
});

it.each([false, true])('reads a directory larger than the tail window without extra I/O (ZIP64 %s)', async force64 => {
  const name = 'a'.repeat(65535);
  const zip = await zipBlobs([{name,data:'preserved'}],{force64});
  const bytes = new DataView(await zip.arrayBuffer()), end = zip.size-22;
  const z64 = force64 ? Number(bytes.getBigUint64(end-12,true)) : null;
  const cdStart = force64 ? Number(bytes.getBigUint64(z64+48,true)) : bytes.getUint32(end+16,true);
  const cdSize = force64 ? Number(bytes.getBigUint64(z64+40,true)) : bytes.getUint32(end+12,true);
  const ranges=[];
  const entries=await readZip({size:zip.size,slice(start,end){ranges.push([start,end]);return zip.slice(start,end);}});
  expect(ranges).toEqual([[zip.size-22-65535,zip.size],[cdStart,cdStart+cdSize]]);
  expect(entries).toHaveLength(1);expect(entries[0].name.length).toBe(name.length);
  expect(await (await entries[0].blob()).text()).toBe('preserved');
});
