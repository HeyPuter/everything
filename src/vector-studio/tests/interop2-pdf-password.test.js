import { describe, it, expect, vi } from 'vitest';
import { createHash, createCipheriv } from 'node:crypto';
import { buildPDF, leaves } from './interop-helpers.js';
import { pdfToDocument, pdfPages } from '../src/features/interop/pdf/import.js';
import { PDFDocument, PDFError } from '../src/features/interop/pdf/document.js';
import { openPDFInfo } from '../src/features/interop/lazy.js';

// Encrypted fixtures are written with Node's crypto, independent of the importer's own primitives.
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (b) => createHash('md5').update(b).digest();
const sha = (alg, b) => createHash(alg).update(b).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const hex = (b) => `<${Buffer.from(b).toString('hex')}>`;

function hash2B(pw, salt, udata) {
  let k = sha('sha256', Buffer.concat([pw, salt, udata]));
  let e = Buffer.alloc(0);
  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round++) {
    const k1 = Buffer.concat([pw, k, udata]);
    const c = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    e = Buffer.concat([c.update(Buffer.concat(Array(64).fill(k1))), c.final()]);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    k = sha(['sha256', 'sha384', 'sha512'][sum % 3], e);
  }
  return k.subarray(0, 32);
}

const CONTENT = '0 0 1 rg 0 0 20 20 re f';

/** A one-page PDF encrypted with the standard handler. r: 2 (RC4-40), 3 (RC4-128), 4 (AES-128), 5 or 6 (AES-256). */
function encryptedPDF({ r, user = '', owner = 'owner' }) {
  const id = Buffer.from('fedcba9876543210');
  const P = -1340;
  const pb = Buffer.alloc(4);
  pb.writeInt32LE(P);
  let encDict;
  let streamOf;
  if (r <= 4) {
    const n = r === 2 ? 5 : 16;
    let oh = md5(padPw(owner));
    if (r >= 3) for (let i = 0; i < 50; i++) oh = md5(oh);
    const okey = oh.subarray(0, n);
    let O = rc4(okey, padPw(user));
    if (r >= 3) for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(okey.map((b) => b ^ i)), O);
    let key = md5(Buffer.concat([padPw(user), O, pb, id]));
    if (r >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
    key = key.subarray(0, n);
    let U;
    if (r === 2) U = rc4(key, PAD);
    else {
      let u = rc4(key, md5(Buffer.concat([PAD, id])));
      for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
      U = Buffer.concat([u, Buffer.alloc(16)]);
    }
    const objKey = (num, aes) => md5(Buffer.concat([key, Buffer.from([num & 255, 0, 0, 0, 0]), aes ? Buffer.from('sAlT') : Buffer.alloc(0)])).subarray(0, Math.min(16, n + 5));
    if (r === 4) {
      streamOf = (num, data) => {
        const iv = Buffer.alloc(16, 9);
        const c = createCipheriv('aes-128-cbc', objKey(num, true), iv);
        return Buffer.concat([iv, c.update(data), c.final()]);
      };
      encDict = `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(U)} /P ${P} >>`;
    } else {
      streamOf = (num, data) => rc4(objKey(num, false), data);
      encDict = `<< /Filter /Standard /V ${r === 2 ? 1 : 2} /R ${r} /Length ${n * 8} /O ${hex(O)} /U ${hex(U)} /P ${P} >>`;
    }
  } else {
    const fileKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) fileKey[i] = (i * 37 + 11) & 255;
    const hash = (pw, salt, udata) => (r === 5 ? sha('sha256', Buffer.concat([pw, salt, udata])) : hash2B(pw, salt, udata));
    const wrap = (k) => {
      const c = createCipheriv('aes-256-cbc', k, Buffer.alloc(16));
      c.setAutoPadding(false);
      return Buffer.concat([c.update(fileKey), c.final()]);
    };
    const up = Buffer.from(user, 'utf8');
    const op = Buffer.from(owner, 'utf8');
    const [uv, uk, ov, ok] = [1, 2, 3, 4].map((s) => Buffer.alloc(8, s));
    const U = Buffer.concat([hash(up, uv, Buffer.alloc(0)), uv, uk]);
    const UE = wrap(hash(up, uk, Buffer.alloc(0)));
    const O = Buffer.concat([hash(op, ov, U), ov, ok]);
    const OE = wrap(hash(op, ok, U));
    streamOf = (num, data) => {
      const iv = Buffer.alloc(16, 5);
      const c = createCipheriv('aes-256-cbc', fileKey, iv);
      return Buffer.concat([iv, c.update(data), c.final()]);
    };
    encDict = `<< /Filter /Standard /V 5 /R ${r} /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(U)} /OE ${hex(OE)} /UE ${hex(UE)} /P ${P} /Perms <${'00'.repeat(16)}> >>`;
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 50] /Contents 4 0 R >>',
    { dict: '<< >>', stream: new Uint8Array(streamOf(4, Buffer.from(CONTENT))) },
    encDict,
  ];
  return buildPDF(objs, { trailer: `/Encrypt 5 0 R /ID [${hex(id)} ${hex(id)}]` });
}

const CASES = [
  { r: 2, label: 'RC4 40-bit' },
  { r: 3, label: 'RC4 128-bit' },
  { r: 4, label: 'AES-128' },
  { r: 5, label: 'AES-256 (revision 5)' },
  { r: 6, label: 'AES-256 (revision 6)' },
];

describe('PDF open passwords', () => {
  for (const { r, label } of CASES) {
    it(`opens ${label} files with the user or the owner password and rejects wrong ones`, async () => {
      const bytes = encryptedPDF({ r, user: 'sesame', owner: 'master key' });
      let err = null;
      try {
        new PDFDocument(bytes);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PDFError);
      expect(err.code).toBe('password');
      expect(() => new PDFDocument(bytes, { password: 'wrong' })).toThrow(/not correct/);
      for (const password of ['sesame', 'master key']) {
        const info = pdfPages(bytes, { password });
        const doc = await pdfToDocument(info.doc, { families: ['Inter'] });
        expect(leaves(doc)[0].fill.color).toBe('#0000ff');
      }
    });
  }

  it('still opens files with an empty user password without asking', async () => {
    const doc = await pdfToDocument(encryptedPDF({ r: 6, user: '' }), { families: ['Inter'] });
    expect(leaves(doc)[0].fill.color).toBe('#0000ff');
  });

  it('accepts non-Latin passwords for AES-256 files', () => {
    const bytes = encryptedPDF({ r: 6, user: 'pässwörd✓' });
    expect(() => pdfPages(bytes, { password: 'pässwörd✓' })).not.toThrow();
  });

  it('asks for the password and retries until it is right, without keeping it', async () => {
    const bytes = encryptedPDF({ r: 4, user: 'sesame' });
    const seen = [];
    const app = {
      dialogs: {
        open: vi.fn(async (opts) => {
          const input = opts.body.querySelector('input[type=password]');
          const ok = opts.buttons.find((b) => b.primary);
          const error = opts.body.querySelector('[role=alert]');
          input.value = 'nope';
          expect(await ok.validate()).toBe(false);
          seen.push(error.textContent);
          input.value = 'sesame';
          expect(await ok.validate()).toBe(true);
          // The field is cleared once the file is open.
          expect(input.value).toBe('');
          return ok.value();
        }),
      },
    };
    const info = await openPDFInfo(app, bytes, 'locked.pdf');
    expect(app.dialogs.open).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatch(/not correct/);
    expect(info.pages).toHaveLength(1);
    expect(JSON.stringify(Object.keys(info.doc))).not.toMatch(/password/i);
    // Cancelling gives null.
    const cancel = { dialogs: { open: async () => null } };
    expect(await openPDFInfo(cancel, bytes, 'locked.pdf')).toBeNull();
    // Unencrypted files never ask.
    const plain = { dialogs: { open: vi.fn() } };
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R >>'];
    expect((await openPDFInfo(plain, buildPDF(objs), 'a.pdf')).pages).toHaveLength(1);
    expect(plain.dialogs.open).not.toHaveBeenCalled();
  });
});
