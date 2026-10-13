// Verifying C2PA manifests made elsewhere or changed after signing: only
// assertions the claim lists count, only the active manifest is bound to the
// file, other signature algorithms are checked (or said to be unchecked), and
// a matching signature never claims to show who signed.
import { beforeAll, describe, expect, it } from 'vitest';
import { deflate } from 'pako';
import { CborTag, encodeCbor } from '../src/imaging/provenance/cbor';
import { contentBox, readJumbf, superbox, writeJumbf, type JumbfSuperbox } from '../src/imaging/provenance/jumbf';
import { oid, tlv } from '../src/imaging/provenance/x509';
import { buildManifestStore, readManifestStore } from '../src/imaging/provenance/c2pa';
import { attachProvenance, createSigner, inspectProvenance, type ProvenanceSigner } from '../src/imaging/provenance';
import { readStore } from '../src/imaging/provenance/containers';
import { buildPng, readPngChunks } from '../src/imaging/codecs/png-chunks';
import { reportHtml } from '../src/features/provenance/inspect';
import { NOW, sampleRecord } from './provenance-fixtures';

const ab = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', ab(b)));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
const seq = (...items: Uint8Array[]) => tlv(0x30, cat(...items));
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, new TextEncoder().encode(cn)))));
const utc = (s: string) => tlv(0x17, new TextEncoder().encode(s));
/** A certificate for `spki` naming `subject`, claiming to be issued by
 * `issuer`. Its own signature is filler: nothing vouches for it. */
function certificate(spki: Uint8Array, subject: string, issuer: string): Uint8Array {
  const alg = seq(oid('1.2.840.10045.4.3.2'));
  const tbs = seq(tlv(0xa0, tlv(0x02, Uint8Array.of(2))), tlv(0x02, Uint8Array.of(7)), alg, name(issuer), seq(utc('260101000000Z'), utc('360101000000Z')), name(subject), spki);
  return seq(tbs, alg, tlv(0x03, Uint8Array.of(0, 1, 2, 3)));
}

type Key = { alg: number; privateKey: CryptoKey; certificate: Uint8Array; params: AlgorithmIdentifier | EcdsaParams | RsaPssParams };
async function key(alg: number, gen: RsaHashedKeyGenParams | EcKeyGenParams | Algorithm, params: Key['params'], subject = 'Example Signer', issuer = subject): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(gen, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { alg, privateKey: pair.privateKey, certificate: certificate(spki, subject, issuer), params };
}
async function sign1(payload: Uint8Array, k: Key): Promise<Uint8Array> {
  const prot = encodeCbor(new Map<number, unknown>([[1, k.alg], [33, k.certificate]]));
  const tbs = encodeCbor(['Signature1', prot, new Uint8Array(0), payload]);
  const sig = new Uint8Array(await crypto.subtle.sign(k.params, k.privateKey, ab(tbs)));
  return encodeCbor(new CborTag(18, [prot, new Map(), null, sig]));
}

const cborBox = (label: string, value: unknown) => superbox('cbor', label, [contentBox('cbor', encodeCbor(value))]);
/** A manifest as another tool might write it (claim version 1 or 2). */
async function manifest(k: Key, opts: { label?: string; v2?: boolean; dataHash?: Uint8Array; exclusion?: { start: number; length: number } } = {}): Promise<JumbfSuperbox> {
  const assertions = [
    cborBox('c2pa.actions.v2', { actions: [{ action: 'c2pa.created', description: 'Made elsewhere' }] }),
    cborBox('c2pa.hash.data', { exclusions: [opts.exclusion ?? { start: 0, length: 0 }], name: 'jumbf manifest', alg: 'sha256', hash: opts.dataHash ?? new Uint8Array(32), pad: new Uint8Array(0) }),
  ];
  const refs = await Promise.all(assertions.map(async (a) => ({ url: `self#jumbf=c2pa.assertions/${a.label}`, hash: await sha(writeJumbf(a).subarray(8)) })));
  const claim = encodeCbor(
    opts.v2
      ? { instanceID: 'xmp:iid:1', claim_generator_info: { name: 'Example Tool', version: '2.0' }, signature: 'self#jumbf=c2pa.signature', created_assertions: refs, alg: 'sha256' }
      : { 'dc:title': 'Elsewhere', instanceID: 'xmp:iid:1', claim_generator: 'Example_Tool/1.0', signature: 'self#jumbf=c2pa.signature', assertions: refs, alg: 'sha256' },
  );
  return superbox('c2ma', opts.label ?? 'urn:uuid:00000000-0000-4000-8000-000000000001', [
    superbox('c2as', 'c2pa.assertions', assertions),
    superbox(opts.v2 ? 'c2cl' : 'c2cl', opts.v2 ? 'c2pa.claim.v2' : 'c2pa.claim', [contentBox('cbor', claim)]),
    superbox('c2cs', 'c2pa.signature', [contentBox('cbor', await sign1(claim, k))]),
  ]);
}
const storeOf = (...manifests: JumbfSuperbox[]) => writeJumbf(superbox('c2pa', 'c2pa', manifests));

function png(v: number) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 2);
  dv.setUint32(4, 2);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array(2 * (1 + 8));
  for (let i = 0; i < raw.length; i++) raw[i] = i % 9 ? v : 0;
  return buildPng([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: deflate(raw) }, { type: 'IEND', data: new Uint8Array() }]);
}

/** Rewrite the signed PNG's store and pixels; `extra` assertions are
 * appended to the store unsigned. The added data hash is solved to a fixed
 * point so it matches the changed file exactly. */
async function tamper(signed: Uint8Array, extra: (ex: { start: number; length: number }, hash: Uint8Array) => JumbfSuperbox[], pixels = png(200)) {
  const chunks = readPngChunks(signed);
  const root = readJumbf(readStore(signed, 'png')!.store);
  const m = root.children[0] as JumbfSuperbox;
  const astore = m.children[0] as JumbfSuperbox;
  const idat = readPngChunks(pixels).find((c) => c.type === 'IDAT')!.data;
  let ex = { start: 0, length: 0 };
  let hash = new Uint8Array(32);
  let file = signed;
  for (let i = 0; i < 6; i++) {
    const store = writeJumbf({ ...root, children: [{ ...m, children: [{ ...astore, children: [...astore.children, ...extra(ex, hash)] }, ...m.children.slice(1)] }] } as JumbfSuperbox);
    file = buildPng(chunks.map((c) => (c.type === 'caBX' ? { type: 'caBX', data: store } : c.type === 'IDAT' ? { type: 'IDAT', data: idat } : { type: c.type, data: c.data })));
    const loc = readPngChunks(file).find((c) => c.type === 'caBX')!;
    ex = { start: loc.offset, length: loc.data.length + 12 };
    hash = await sha(cat(file.subarray(0, ex.start), file.subarray(ex.start + ex.length)));
  }
  return file;
}

let signer: ProvenanceSigner;
let es256: Key;
beforeAll(async () => {
  signer = await createSigner('Photo Studio test key', NOW);
  es256 = await key(-7, { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' });
});

describe('only signed assertions count', () => {
  it('an unsigned second data hash cannot make changed pixels look bound', async () => {
    const signed = (await attachProvenance(png(10), 'png', sampleRecord(), { title: 'T', signer, now: NOW })).bytes;
    const forged = await tamper(signed, (ex, hash) => [cborBox('c2pa.hash.data', { exclusions: [ex], name: 'jumbf manifest', alg: 'sha256', hash, pad: new Uint8Array(0) })]);
    const r = await inspectProvenance(forged);
    const m = r.c2pa!.manifests[0];
    expect(m.signature.valid).toBe(true);
    expect(m.dataHashValid).toBe(false);
    expect(m.binding).toBe('changed');
    expect(m.assertionHashesValid).toBe(false);
    expect(m.unlisted).toEqual(['c2pa.hash.data']);
    expect(m.errors.join(' ')).toMatch(/2 assertions labelled c2pa\.hash\.data/);
    const { html } = await reportHtml('forged.png', forged);
    expect(html).toContain('Changed');
    expect(html).toContain('Unsigned');
    expect(html).not.toContain('Bound');
  });

  it('unsigned assertions are not shown as the manifest’s content', async () => {
    const signed = (await attachProvenance(png(10), 'png', sampleRecord(), { title: 'T', signer, now: NOW })).bytes;
    const forged = await tamper(signed, () => [cborBox('c2pa.actions.v2', { actions: [{ action: 'c2pa.created', parameters: { description: 'Forged step' } }] })], png(10));
    const m = (await inspectProvenance(forged)).c2pa!.manifests[0];
    expect(m.actions.map((a) => a.description)).not.toContain('Forged step');
    expect(m.unlisted).toEqual(['c2pa.actions.v2']);
    expect(m.assertionHashesValid).toBe(false);
  });
});

describe('signatures', () => {
  it('a certificate naming an authority is not presented as a verified signer', async () => {
    const forged = await key(-7, { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }, 'Example Newsroom', 'Example CA');
    const report = await readManifestStore(storeOf(await manifest(forged)));
    const m = report.manifests[0];
    expect(m.signature).toMatchObject({ valid: true, checked: true, selfSigned: false, subject: 'CN=Example Newsroom', issuer: 'CN=Example CA' });
    // The report page always carries the trust caveat and never says "signed by".
    const signedPng = (await attachProvenance(png(10), 'png', sampleRecord(), { title: 'T', signer: { privateKey: forged.privateKey, certificate: forged.certificate }, now: NOW })).bytes;
    const { html } = await reportHtml('news.png', signedPng);
    expect(html).toContain('No trust list is checked');
    expect(html).toContain('matches the certificate embedded in the file');
    expect(html).not.toMatch(/signed by/i);
    expect(html).not.toContain('>Valid<');
    expect(html).toContain('certificate names CN=Example Newsroom, issued by CN=Example CA');
  });

  it('checks ES384, PS256 and Ed25519 signatures', async () => {
    const keys = [
      await key(-35, { name: 'ECDSA', namedCurve: 'P-384' }, { name: 'ECDSA', hash: 'SHA-384' }),
      await key(-37, { name: 'RSA-PSS', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, { name: 'RSA-PSS', saltLength: 32 }),
      await key(-8, { name: 'Ed25519' }, { name: 'Ed25519' }),
    ];
    const names = [];
    for (const k of keys) {
      const m = (await readManifestStore(storeOf(await manifest(k)))).manifests[0];
      expect(m.errors).toEqual([]);
      expect(m.signature).toMatchObject({ valid: true, checked: true });
      names.push(m.signature.algorithm);
      // A changed claim still fails.
      const bad = await manifest(k);
      const claimBox = bad.children[1] as JumbfSuperbox;
      const store = storeOf({ ...bad, children: [bad.children[0], { ...claimBox, children: [contentBox('cbor', encodeCbor({ assertions: [] }))] }, bad.children[2]] });
      expect((await readManifestStore(store)).manifests[0].signature).toMatchObject({ valid: false, checked: true });
    }
    expect(names).toEqual(['ES384', 'PS256', 'Ed25519']);
  });

  it('says an algorithm it does not know cannot be checked rather than invalid', async () => {
    const k = { ...es256, alg: -47 };
    const m = (await readManifestStore(storeOf(await manifest(k)))).manifests[0];
    expect(m.signature).toMatchObject({ valid: false, checked: false });
    const signedPng = (await attachProvenance(png(10), 'png', sampleRecord(), { title: 'T', signer, now: NOW })).bytes;
    // Swap the signature of the PNG's manifest for one in the unknown algorithm.
    const root = readJumbf(readStore(signedPng, 'png')!.store);
    const mm = root.children[0] as JumbfSuperbox;
    const claim = (mm.children[1] as JumbfSuperbox).children[0] as { data: Uint8Array };
    const store = writeJumbf({ ...root, children: [{ ...mm, children: [mm.children[0], mm.children[1], superbox('c2cs', 'c2pa.signature', [contentBox('cbor', await sign1(claim.data, k))])] }] } as JumbfSuperbox);
    const html = (await reportHtml('x.png', buildPng(readPngChunks(signedPng).map((c) => (c.type === 'caBX' ? { type: 'caBX', data: store } : { type: c.type, data: c.data }))))).html;
    expect(html).toContain('Not checked');
    expect(html).not.toContain('Invalid');
  });
});

describe('manifests made by other tools', () => {
  it('reads version 2 claims (created assertions) as intact', async () => {
    const m = (await readManifestStore(storeOf(await manifest(es256, { v2: true })))).manifests[0];
    expect(m.errors).toEqual([]);
    expect(m.assertionHashesValid).toBe(true);
    expect(m.claimGenerator).toBe('Example Tool/2.0');
    expect(m.actions.map((a) => a.description)).toEqual(['Made elsewhere']);
  });

  it('binds only the active manifest to the file', async () => {
    const file = png(10);
    const hash = await sha(file);
    const ingredient = await manifest(es256, { label: 'urn:uuid:00000000-0000-4000-8000-00000000000a' });
    const active = await manifest(es256, { label: 'urn:uuid:00000000-0000-4000-8000-00000000000b', dataHash: hash });
    const report = await readManifestStore(storeOf(ingredient, active), file);
    const [first, last] = report.manifests;
    expect(report.active).toBe(last.label);
    expect(first.errors).toEqual([]);
    expect(first.binding).toBeUndefined();
    expect(first.dataHashValid).toBeUndefined();
    expect(last.binding).toBe('bound');
    expect(last.dataHashValid).toBe(true);
  });

  it('reports an active manifest without a signed hard binding as unbound', async () => {
    const own = await buildManifestStore(
      { record: sampleRecord(), title: 'Kite', format: 'png', manifestId: 'aaaaaaaa-0000-4000-8000-000000000001', instanceId: 'bbbbbbbb-0000-4000-8000-000000000002', generator: { name: 'Photo Studio', version: '1.0' }, now: NOW },
      signer,
      { start: 0, length: 0 },
      new Uint8Array(32),
    );
    // Drop the data hash from the store: the claim's reference to it is now missing.
    const root = readJumbf(own);
    const m = root.children[0] as JumbfSuperbox;
    const astore = m.children[0] as JumbfSuperbox;
    const store = writeJumbf({ ...root, children: [{ ...m, children: [{ ...astore, children: astore.children.filter((a) => (a as JumbfSuperbox).label !== 'c2pa.hash.data') }, ...m.children.slice(1)] }] } as JumbfSuperbox);
    const r = (await readManifestStore(store, png(10))).manifests[0];
    expect(r.binding).toBe('missing');
    expect(r.dataHashValid).toBe(false);
    expect(r.assertionHashesValid).toBe(false);
  });
});
