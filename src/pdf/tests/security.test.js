import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PasswordError,
  aesCbcDecrypt,
  aesCbcEncrypt,
  md5,
  openedProtection,
  permissionFlags,
  protectPdf,
  rc4,
  toHex,
  unlockPdf,
} from '../src/core/security.js';
import { samplePdf, validatePdf } from '../src/core/document.js';

const FIXTURES = new URL('./fixtures/security/', import.meta.url);
const fixture = (name) => readFile(new URL(`${name}.pdf`, FIXTURES)).then((b) => new Uint8Array(b));
const hex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));

/** Open with PDF.js, an independent implementation of the same security handler. */
async function inspect(bytes, password) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      pages.push((await page.getTextContent()).items.map((item) => item.str).join(''));
    }
    const meta = await pdf.getMetadata();
    return { pages, title: meta.info.Title, permissions: await pdf.getPermissions() };
  } finally {
    await task.destroy();
  }
}
async function expectUnlocked(bytes) {
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(2);
  expect(doc.getTitle()).toBe('Secret Title');
  expect(doc.getAuthor()).toBe('Ada');
  expect(doc.getForm().getTextField('name').getText()).toBe('Grace');
  const seen = await inspect(bytes);
  expect(seen.pages[0]).toContain('Secret report');
  expect(seen.pages[1]).toContain('Second page');
}

describe('primitives', () => {
  it('computes MD5 like Node', () => {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'x'.repeat(1000),
    ]) {
      const expected = createHash('md5').update(text).digest('hex');
      expect(toHex(md5(new TextEncoder().encode(text)))).toBe(expected);
    }
  });
  it('matches the FIPS-197 AES vectors in both directions', () => {
    const plain = hex('00112233445566778899aabbccddeeff');
    const iv = new Uint8Array(16);
    const key128 = hex('000102030405060708090a0b0c0d0e0f');
    const key256 = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(toHex(aesCbcEncrypt(key128, iv, plain))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    expect(toHex(aesCbcEncrypt(key256, iv, plain))).toBe('8ea2b7ca516745bfeafc49904b496089');
    expect(toHex(aesCbcDecrypt(key128, iv, hex('69c4e0d86a7b0430d8cdb78070b4c55a')))).toBe(
      toHex(plain),
    );
    const long = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
    expect(aesCbcDecrypt(key256, plain, aesCbcEncrypt(key256, plain, long))).toEqual(long);
  });
  it('matches the RC4 test vectors', () => {
    expect(toHex(rc4(new TextEncoder().encode('Key'), new TextEncoder().encode('Plaintext')))).toBe(
      'bbf316e8d940af0ad3',
    );
    expect(
      toHex(rc4(new TextEncoder().encode('Secret'), new TextEncoder().encode('Attack at dawn'))),
    ).toBe('45a01f645fc35b383552544b9bf5');
  });
  it('builds permission flags with the fixed bits set', () => {
    expect(permissionFlags()).toBe(-4);
    expect(permissionFlags({ print: false, copy: false, annotate: false, edit: false })).toBe(
      0xfffff0c0 | 0x200 | 0,
    );
    expect(permissionFlags({ print: false }) & 0x804).toBe(0);
    expect(permissionFlags({ copy: false }) & 0x10).toBe(0);
    // A file's finer permissions stay while their permission is left as the file had it.
    const lowResolutionFormsOnly = permissionFlags() & ~0x800 & ~0x20;
    expect(permissionFlags({ annotate: false }, lowResolutionFormsOnly)).toBe(
      lowResolutionFormsOnly,
    );
    expect(permissionFlags({ print: false, annotate: true }, lowResolutionFormsOnly)).toBe(
      permissionFlags({ print: false }),
    );
  });
});

const names = [
  'rc4-40',
  'rc4-128',
  'rc4-128-objstm',
  'aes-128',
  'aes-128-plain-metadata',
  'aes-256-r5',
  'aes-256',
  'aes-256-objstm',
  'aes-256-linearized',
];
describe('unlocking PDFs encrypted by qpdf', () => {
  it('keeps every fixture covered', async () => {
    const files = (await readdir(FIXTURES))
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => f.replace(/\.pdf$/, ''))
      .sort();
    expect(files).toEqual(
      [
        ...names,
        'owner-only',
        'unicode-password',
        'rc4-latin1-password',
        'rc4-40-r3',
        'r6-fullwidth-password',
        'r6-decomposed-password',
      ].sort(),
    );
  });
  for (const name of names) {
    it(`opens ${name} with the user password, the owner password, and nothing else`, async () => {
      const bytes = await fixture(name);
      await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
      await expect(unlockPdf(bytes, 'wrong')).rejects.toBeInstanceOf(PasswordError);
      await expect(unlockPdf(bytes, '')).rejects.toBeInstanceOf(PasswordError);
      const user = await unlockPdf(bytes, 'user');
      expect(user.owner).toBe(false);
      await expectUnlocked(user.bytes);
      const owner = await unlockPdf(bytes, 'owner');
      expect(owner.owner).toBe(true);
      await expectUnlocked(owner.bytes);
    });
  }
  it('opens a revision 3 file with a 40-bit key by its owner password too', async () => {
    const bytes = await fixture('rc4-40-r3');
    expect((await unlockPdf(bytes, 'abc')).owner).toBe(false);
    const { owner, bytes: unlocked } = await unlockPdf(bytes, 'own');
    expect(owner).toBe(true);
    expect((await PDFDocument.load(unlocked)).getPageCount()).toBeGreaterThan(0);
    await expect(unlockPdf(bytes, 'nope')).rejects.toThrow(PasswordError);
  });
  it('opens revision 6 files whose password was hashed as typed instead of normalized', async () => {
    for (const [name, password] of [
      ['r6-fullwidth-password', 'ａbc'],
      ['r6-decomposed-password', 'e\u0301clair'],
    ]) {
      const bytes = await fixture(name);
      expect((await unlockPdf(bytes, password)).owner).toBe(false);
      expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
      await expect(unlockPdf(bytes, password.normalize('NFKC'))).rejects.toBeInstanceOf(
        PasswordError,
      );
    }
  });
  it('opens a PDF that only restricts permissions without asking for a password', async () => {
    const bytes = await fixture('owner-only');
    const { owner, bytes: unlocked } = await unlockPdf(bytes, '');
    expect(owner).toBe(false);
    await expectUnlocked(unlocked);
    expect((await unlockPdf(bytes, 'owner')).owner).toBe(true);
  });
  it('accepts non-ASCII passwords for both password encodings', async () => {
    await expectUnlocked((await unlockPdf(await fixture('unicode-password'), 'pässwörd')).bytes);
    await expectUnlocked((await unlockPdf(await fixture('rc4-latin1-password'), 'pässwörd')).bytes);
    await expect(unlockPdf(await fixture('unicode-password'), 'passwordx')).rejects.toBeInstanceOf(
      PasswordError,
    );
  });
  it('is reported as encrypted by validation, distinct from damaged files', async () => {
    const error = await validatePdf(await fixture('aes-256')).catch((e) => e);
    expect(error.code).toBe('encrypted');
    expect(error.message).toMatch(/password/);
    await expect(unlockPdf(await samplePdf(), '')).rejects.toThrow(/not password protected/);
  });
});

describe('protecting PDFs', () => {
  it('encrypts with AES-256 so that PDF.js needs the password and pdf-lib refuses the file', async () => {
    const original = await samplePdf();
    const before = await inspect(original);
    const protectedBytes = await protectPdf(original, { open: 'open sesame' });
    await expect(PDFDocument.load(protectedBytes)).rejects.toThrow(/encrypted/i);
    await expect(inspect(protectedBytes)).rejects.toMatchObject({ name: 'PasswordException' });
    await expect(inspect(protectedBytes, 'nope')).rejects.toMatchObject({
      name: 'PasswordException',
    });
    const after = await inspect(protectedBytes, 'open sesame');
    expect(after.pages).toEqual(before.pages);
    expect(after.title).toBe(before.title);
    for (const flag of Object.values(pdfjs.PermissionFlag))
      expect(after.permissions).toContain(flag);
    expect(new TextDecoder('latin1').decode(protectedBytes.subarray(0, 8))).toBe('%PDF-1.7');
  });
  it('round-trips through the unlocker with either password and keeps forms editable', async () => {
    const original = await fixture('aes-256');
    const plain = (await unlockPdf(original, 'user')).bytes;
    const protectedBytes = await protectPdf(plain, {
      open: 'reader',
      permissions: 'editor',
      allow: { print: false, copy: false },
    });
    const asUser = await unlockPdf(protectedBytes, 'reader');
    expect(asUser.owner).toBe(false);
    await expectUnlocked(asUser.bytes);
    const asOwner = await unlockPdf(protectedBytes, 'editor');
    expect(asOwner.owner).toBe(true);
    await expectUnlocked(asOwner.bytes);
    await expect(unlockPdf(protectedBytes, '')).rejects.toBeInstanceOf(PasswordError);
    const seen = await inspect(protectedBytes, 'reader');
    expect(seen.permissions).not.toBeNull();
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.PRINT);
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.COPY);
    expect(seen.permissions).toContain(pdfjs.PermissionFlag.MODIFY_CONTENTS);
    expect(seen.permissions).toContain(pdfjs.PermissionFlag.FILL_INTERACTIVE_FORMS);
  });
  it('restricts permissions without an open password', async () => {
    const original = await samplePdf();
    const protectedBytes = await protectPdf(original, {
      permissions: 'owner',
      allow: { edit: false, annotate: false },
    });
    const seen = await inspect(protectedBytes);
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.MODIFY_CONTENTS);
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.MODIFY_ANNOTATIONS);
    expect(seen.permissions).toContain(pdfjs.PermissionFlag.PRINT);
    const opened = await unlockPdf(protectedBytes, '');
    expect(opened.owner).toBe(false);
    expect((await unlockPdf(protectedBytes, 'owner')).owner).toBe(true);
    expect((await inspect(opened.bytes)).pages).toEqual((await inspect(original)).pages);
    await expect(protectPdf(original, {})).rejects.toThrow(/password/);
  });
  it('writes an unchanged protection back as it was, whichever password opened the file', async () => {
    const revision = (bytes) => {
      const text = new TextDecoder('latin1').decode(bytes);
      const at = text.indexOf('/Standard');
      return /\/R\s+(\d)/.exec(text.slice(at, at + 2000))?.[1];
    };
    for (const name of names) {
      const original = await fixture(name);
      const expected = await inspect(original, 'user');
      for (const password of ['user', 'owner']) {
        const opened = await unlockPdf(original, password);
        const protection = openedProtection(opened, password);
        expect(protection.original).toBe(opened.encryption);
        expect(protection[opened.owner ? 'permissions' : 'open']).toBe(password);
        // The open password of older revisions follows from the permissions password.
        const other = opened.owner && opened.encryption.security.R < 5 ? 'user' : null;
        expect(protection[opened.owner ? 'open' : 'permissions']).toBe(other);
        // An edit in between, as the working copy is plain and re-saved by pdf-lib.
        const doc = await PDFDocument.load(opened.bytes);
        doc.setSubject('Edited');
        const again = await protectPdf(await doc.save(), protection);
        expect(revision(again)).toBe(revision(original));
        expect((await unlockPdf(again, 'user')).owner).toBe(false);
        const asOwner = await unlockPdf(again, 'owner');
        expect(asOwner.owner).toBe(true);
        await expectUnlocked(asOwner.bytes);
        expect((await PDFDocument.load(asOwner.bytes)).getSubject()).toBe('Edited');
        await expect(unlockPdf(again, 'other')).rejects.toBeInstanceOf(PasswordError);
        const seen = await inspect(again, 'user');
        expect(seen.pages).toEqual(expected.pages);
        expect(seen.permissions).toEqual(expected.permissions);
      }
    }
    // A file that only restricts permissions keeps them, and its owner password, too.
    const restricted = await fixture('owner-only');
    const opened = await unlockPdf(restricted, '');
    const protection = openedProtection(opened, '');
    expect(protection).toMatchObject({
      open: '',
      permissions: null,
      allow: { print: false, copy: false, annotate: true, edit: true },
    });
    const again = await protectPdf(opened.bytes, protection);
    const seen = await inspect(again);
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.PRINT);
    expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.COPY);
    expect(seen.permissions).toContain(pdfjs.PermissionFlag.MODIFY_CONTENTS);
    expect((await unlockPdf(again, '')).owner).toBe(false);
    expect((await unlockPdf(again, 'owner')).owner).toBe(true);
    // A changed protection is written fresh, with AES-256.
    const changed = await protectPdf(opened.bytes, { ...protection, original: null, open: 'new' });
    expect(revision(changed)).toBe('6');
    await expect(unlockPdf(changed, '')).rejects.toBeInstanceOf(PasswordError);
    await expectUnlocked((await unlockPdf(changed, 'new')).bytes);
  });
  it('keeps the open password of a file opened with its permissions password', async () => {
    for (const [name, password, ownerPassword = 'owner'] of [
      ...names.map((name) => [name, 'user']),
      ['rc4-40-r3', 'abc', 'own'],
      ['rc4-latin1-password', 'pässwörd'],
      ['unicode-password', 'pässwörd'],
    ]) {
      const original = await fixture(name);
      const opened = await unlockPdf(original, ownerPassword);
      const protection = openedProtection(opened, ownerPassword);
      const modern = opened.encryption.security.R >= 5;
      // Older revisions derive it from the permissions password; AES-256 keeps its checks.
      expect(protection.open).toBe(modern ? null : password);
      const allow = { print: false };
      const changed = await protectPdf(opened.bytes, {
        open: protection.open,
        permissions: 'boss',
        allow,
        openFrom: protection.original,
      });
      await expect(unlockPdf(changed, '')).rejects.toBeInstanceOf(PasswordError);
      expect((await unlockPdf(changed, password)).owner, name).toBe(false);
      expect((await unlockPdf(changed, 'boss')).owner).toBe(true);
      const seen = await inspect(changed, password);
      expect(seen.pages).toEqual((await inspect(original, password)).pages);
      expect(seen.permissions).not.toContain(pdfjs.PermissionFlag.PRINT);
    }
  }, 60000);

  it('protects a PDF with many object types and reopens it byte-for-byte in content', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawText('Encrypted page', { x: 30, y: 200, size: 20 });
    page.drawRectangle({ x: 30, y: 30, width: 100, height: 50 });
    doc.setTitle('Tïtle with ünicode');
    doc.setKeywords(['alpha', 'beta']);
    const bytes = await doc.save();
    const protectedBytes = await protectPdf(bytes, { open: 'pw' });
    const unlocked = await PDFDocument.load((await unlockPdf(protectedBytes, 'pw')).bytes);
    expect(unlocked.getTitle()).toBe('Tïtle with ünicode');
    expect(unlocked.getKeywords()).toBe('alpha beta');
    const seen = await inspect(protectedBytes, 'pw');
    expect(seen.pages).toEqual(['Encrypted page']);
  });
});

describe('revision-6 version declarations', () => {
  async function encryptedDoc(doc) {
    const bytes = await protectPdf(await doc.save(), { open: 'audit' });
    return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  }
  it('declares Adobe extension level 8 for AES-256 and opens with an independent reader', async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Encrypted report');
    const bytes = await protectPdf(await doc.save(), { open: 'audit' });
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('%PDF-1.7');
    const raw = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const adbe = raw.catalog.lookup(PDFName.of('Extensions'))?.lookup(PDFName.of('ADBE'));
    expect(adbe?.get(PDFName.of('BaseVersion'))?.toString()).toBe('/1.7');
    expect(adbe?.get(PDFName.of('ExtensionLevel'))?.asNumber()).toBe(8);
    const security = raw.context.lookup(raw.context.trailerInfo.Encrypt);
    expect(security.lookup(PDFName.of('V')).asNumber()).toBe(5);
    expect(security.lookup(PDFName.of('R')).asNumber()).toBe(6);
    expect(
      security
        .lookup(PDFName.of('CF'))
        .lookup(PDFName.of('StdCF'))
        .get(PDFName.of('CFM'))
        .toString(),
    ).toBe('/AESV3');
    expect((await inspect(bytes, 'audit')).pages[0]).toBe('Encrypted report');
  });
  it.each([3, 8, 9])(
    'upgrades only an older Adobe level (%s), preserving other declarations',
    async (level) => {
      const doc = await PDFDocument.create();
      doc.addPage();
      doc.catalog.set(
        PDFName.of('Extensions'),
        doc.context.register(
          doc.context.obj({
            ADBE: doc.context.register(
              doc.context.obj({ BaseVersion: '1.7', ExtensionLevel: level, Extra: 'Keep' }),
            ),
            ESIC: { BaseVersion: '1.7', ExtensionLevel: 5 },
          }),
        ),
      );
      const saved = await encryptedDoc(doc);
      const extensions = saved.catalog.lookup(PDFName.of('Extensions'));
      const adbe = extensions.lookup(PDFName.of('ADBE'));
      expect(adbe.lookup(PDFName.of('ExtensionLevel')).asNumber()).toBe(Math.max(8, level));
      expect(adbe.get(PDFName.of('Extra')).toString()).toBe('/Keep');
      expect(
        extensions.lookup(PDFName.of('ESIC')).lookup(PDFName.of('ExtensionLevel')).asNumber(),
      ).toBe(5);
    },
  );
  it.each(['header', 'catalog'])(
    'keeps a PDF 2.0 %s requirement without adding an unnecessary extension',
    async (declaration) => {
      const doc = await PDFDocument.create();
      doc.addPage();
      if (declaration === 'catalog') doc.catalog.set(PDFName.of('Version'), PDFName.of('2.0'));
      const bytes = await doc.save();
      if (declaration === 'header') bytes.set(new TextEncoder().encode('%PDF-2.0'));
      const saved = await PDFDocument.load(await protectPdf(bytes, { open: 'audit' }), {
        ignoreEncryption: true,
      });
      expect(saved.catalog.get(PDFName.of('Version')).toString()).toBe('/2.0');
      expect(saved.catalog.has(PDFName.of('Extensions'))).toBe(false);
    },
  );
  it('repairs the declaration when re-exporting existing revision-6 protection', async () => {
    const bytes = await fixture('aes-256');
    const opened = await unlockPdf(bytes, 'user');
    const plain = await PDFDocument.load(opened.bytes);
    plain.catalog.delete(PDFName.of('Extensions'));
    const savedBytes = await protectPdf(await plain.save(), openedProtection(opened, 'user'));
    const raw = await PDFDocument.load(savedBytes, { ignoreEncryption: true });
    expect(
      raw.catalog
        .lookup(PDFName.of('Extensions'))
        ?.lookup(PDFName.of('ADBE'))
        ?.lookup(PDFName.of('ExtensionLevel'))
        ?.asNumber(),
    ).toBe(8);
    await expectUnlocked((await unlockPdf(savedBytes, 'owner')).bytes);
  });
});
