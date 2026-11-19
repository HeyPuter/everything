// Metadata: the BWF UMID field and the iXML tab (scene, take...), read from
// WAV files and written back into WAV exports.
import { describe, it, expect } from 'vitest';
import { bextChunk, parseBext, umidBytes, umidHex, newUmid, parseIxml, writeIxml, withIxmlChunk } from '../src/audio/meta.js';
import { WavWriter } from '../src/export/pcm.js';
import { parseWav } from '../src/audio/wav.js';
import { META_TABS, normalizeMetaValue } from '../src/panels/metadata.js';

const HEX32 = '060A2B340101010501010F2013000000' + '00112233445566778899AABBCCDDEEFF';

async function wavWith(meta, chunks = []) {
  const w = new WavWriter({ sampleRate: 8000, channels: 1, bitDepth: 16, frames: 4, meta, chunks });
  w.write([new Float32Array(4)], 4);
  const blob = await w.finish();
  return parseWav(await blob.arrayBuffer());
}

describe('UMID', () => {
  it('round-trips through the bext chunk', () => {
    const b = bextChunk({ bextOriginator: 'Rec', bextUmid: HEX32 });
    expect(parseBext(b.subarray(8)).bextUmid).toBe(HEX32);
    // No UMID: zeros, read back as empty.
    expect(parseBext(bextChunk({ bextOriginator: 'Rec' }).subarray(8)).bextUmid).toBeUndefined();
  });
  it('keeps an extended UMID whole and ignores bad hex', () => {
    const ext = HEX32 + 'AB'.repeat(32);
    expect(umidHex(umidBytes(ext))).toBe(ext);
    expect(umidHex(umidBytes('zz'))).toBe('');
  });
  it('makes basic UMIDs with the SMPTE label and a random material number', () => {
    const a = newUmid(() => new Uint8Array(16).fill(7));
    expect(a).toHaveLength(64);
    expect(a.startsWith('060A2B34')).toBe(true);
    expect(a.endsWith('07'.repeat(16))).toBe(true);
  });
  it('validates typed UMIDs', () => {
    expect(normalizeMetaValue('bextUmid', HEX32.toLowerCase().match(/.{8}/g).join(' '))).toEqual({ value: HEX32 });
    expect(normalizeMetaValue('bextUmid', 'ABC').error).toMatch(/hexadecimal/);
  });
});

describe('iXML', () => {
  it('lists an iXML tab after BWF', () => {
    expect(META_TABS.map((t) => t.id).slice(0, 2)).toEqual(['bwf', 'ixml']);
    expect(normalizeMetaValue('ixmlCircled', 'yes')).toEqual({ value: 'TRUE' });
    expect(normalizeMetaValue('ixmlCircled', 'maybe').error).toBeTruthy();
  });

  it('writes a new document and reads it back, escaping text', () => {
    const text = writeIxml({ ixmlScene: '12A', ixmlTake: '3', ixmlNote: 'mic <2> & boom' });
    expect(text).toContain('<BWFXML>');
    expect(text).toContain('<NOTE>mic &lt;2&gt; &amp; boom</NOTE>');
    expect(parseIxml(text)).toEqual({ ixmlScene: '12A', ixmlTake: '3', ixmlNote: 'mic <2> & boom' });
    expect(writeIxml({})).toBeNull();
  });

  it('updates a file\'s own iXML and keeps its other elements', () => {
    const own = '<?xml version="1.0"?><BWFXML><IXML_VERSION>1.5</IXML_VERSION><SCENE>1</SCENE><SPEED><MASTER_SPEED>24/1</MASTER_SPEED></SPEED></BWFXML>';
    const text = writeIxml({ ixmlScene: '2', ixmlTake: '5' }, own);
    expect(text).toContain('<MASTER_SPEED>24/1</MASTER_SPEED>');
    expect(parseIxml(text)).toEqual({ ixmlScene: '2', ixmlTake: '5' });
    // A cleared field removes its element.
    expect(writeIxml({}, text)).not.toContain('<SCENE>');
  });

  it('round-trips through a WAV export and replaces a kept iXML chunk', async () => {
    const wav = await wavWith({ ixmlProject: 'Doc', ixmlTake: '7' });
    expect(wav.meta).toMatchObject({ ixmlProject: 'Doc', ixmlTake: '7' });
    const kept = withIxmlChunk([{ id: 'iXML', bytes: new TextEncoder().encode('<BWFXML><TAPE>T1</TAPE><X>keep</X></BWFXML>') }, { id: 'inst', bytes: new Uint8Array(8) }], { ixmlTape: 'T2' });
    expect(kept.map((c) => c.id)).toEqual(['inst', 'iXML']);
    // Unchanged fields, or none given: the file's own chunk is kept as it is.
    const own = [{ id: 'iXML', bytes: new TextEncoder().encode('<BWFXML><TAPE>T1</TAPE></BWFXML>') }];
    expect(withIxmlChunk(own, { ixmlTape: 'T1' })[0].bytes).toBe(own[0].bytes);
    expect(withIxmlChunk(own, {})[0].bytes).toBe(own[0].bytes);
    const again = await wavWith({ ixmlTape: 'T2' }, [{ id: 'iXML', bytes: new TextEncoder().encode('<BWFXML><TAPE>T1</TAPE><X>keep</X></BWFXML>') }]);
    expect(again.meta.ixmlTape).toBe('T2');
    const ix = again.chunks.filter((c) => c.id === 'iXML');
    expect(ix).toHaveLength(1);
    expect(new TextDecoder().decode(ix[0].bytes)).toContain('<X>keep</X>');
  });
});
