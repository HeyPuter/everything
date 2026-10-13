import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { digest } from '../src/engine/sha.js';
import { ENCRYPTION_MATRIX, legacyPasswordKey, legacyKeyText, iteratedHash, bytesToBase64, createPasswordVerifier, verifyPassword, permissionRanges, permissionApplies, protectionGuard, ProtectionError, nextPermissionId } from '../src/engine/protection.js';
import { permissionMarker } from '../src/engine/docx-permissions.js';
import { addPermissionRange, removePermissionRanges } from '../src/engine/permission-edits.js';
import { contentControlRanges } from '../src/engine/content-controls.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);

/** Independently written: protected settings, a permission range for everyone and one for a named editor, and locked styles. */
function protectedDocx({ settings = '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>', body } = {}) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/settings.xml': `<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/>${settings}<w:defaultTabStop w:val="720"/></w:settings>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:locked/><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body ?? '<w:p><w:r><w:t xml:space="preserve">Fixed text. </w:t></w:r><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:t>Open</w:t></w:r><w:permEnd w:id="1"/><w:r><w:t xml:space="preserve"> tail.</w:t></w:r></w:p><w:permStart w:id="7" w:ed="ada@example.com"/><w:p><w:r><w:t>For Ada</w:t></w:r></w:p><w:permEnd w:id="7"/><w:p><w:r><w:t>Closing</w:t></w:r></w:p>'}<w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments }) }; };
const save = async (pkg, d) => unzipSync(new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments).arrayBuffer()));

describe('password verifier (§17.15.1.29)', () => {
  it('derives the key-derivation matrix rows from their seeds', () => {
    // Spot values of the specification's table, typed independently of the generator.
    expect(ENCRYPTION_MATRIX[0]).toEqual([0xAEFC, 0x4DD9, 0x9BB2, 0x2745, 0x4E8A, 0x9D14, 0x2A09]);
    expect(ENCRYPTION_MATRIX[14]).toEqual([0x1021, 0x2042, 0x4084, 0x8108, 0x1231, 0x2462, 0x48C4]);
    expect(ENCRYPTION_MATRIX).toHaveLength(15);
  });

  it('computes the legacy key; its low word is the familiar 16-bit password checksum', () => {
    // 0x83AF is the widely published 16-bit legacy checksum of "password" (the same rotate-and-XOR construction).
    expect(legacyPasswordKey('password') & 0xFFFF).toBe(0x83AF);
    // Vectors computed by a separately written Python implementation (hashlib).
    expect(legacyPasswordKey('password')).toBe(0x147A83AF);
    expect(legacyKeyText(0x147A83AF)).toBe('AF837A14');
    expect(legacyKeyText(0x64CEED7E)).toBe('7EEDCE64'); // the specification's byte-order example
    expect(legacyPasswordKey('Secret')).toBe(0x3445DAE7);
    expect(legacyPasswordKey('élan')).toBe(0x751CCBC5);
    expect(legacyPasswordKey('abcdefghijklmnopqrstuvwxyz')).toBe(legacyPasswordKey('abcdefghijklmno')); // 15 characters count
    expect(legacyPasswordKey('')).toBe(0);
  });

  it('matches the platform digests for every supported algorithm and block boundary', () => {
    for (const algorithm of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) for (const size of [0, 3, 55, 56, 64, 111, 112, 128, 200]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37 + size) & 0xFF);
      expect(Buffer.from(digest(algorithm, bytes)).toString('hex')).toBe(createHash(algorithm.replace('-', '').toLowerCase()).update(bytes).digest('hex'));
    }
  });

  it('reproduces independently computed iterated hashes', () => {
    const b64 = (password, options) => bytesToBase64(iteratedHash(password, { salt: SALT, ...options }));
    expect(b64('password')).toBe('4rOTG/MwYlSJ4565z4hrF8V/7lr1APYteXrflsxTHLojytNOf6N6lINftoVjzehQpL6IZBhd3SdxNAqIXd/mAQ==');
    expect(b64('Secret')).toBe('KlmOui9cgMRPdqWJ3kdK7rRJiT2ZEtIsTxmWqn/vmlQ5zaPMr/4Ex6UVUxQnPWJenSGKGq/wl//mXH2y0nhR+w==');
    expect(b64('élan')).toBe('CM+fkXJBZ42mXVsQw4mYW/dTV/3kTPdEwDQg1MI9B1vdXUtfBaYi/7363AnXhnqZ/U4OrNggXaDSXlG8J+NW1w==');
    expect(b64('password', { legacy: false })).toBe('x01qKaF9y9cQwPxHrE46zKhOLAHXLgmWjpZRPwqjkl6tpT1Lq9JXlHzPvHxsy/q0gWkWsUumW+mgF2sVqd4VXQ==');
    expect(b64('password', { algorithm: 'SHA-1', spinCount: 10 })).toBe('OWGJpZ/FNylOE5PbiaZRI1iPs9o=');
    expect(b64('password', { algorithm: 'SHA-256', spinCount: 0 })).toBe('JhyxXz+17XxzaO4DcJ6i3ugQ0xumaPM6KAvf8X5dl/4=');
  });

  it('creates and verifies verifiers in either attribute form', async () => {
    const verifier = await createPasswordVerifier('open sesame', { salt: SALT, spinCount: 1000 });
    expect(verifier).toMatchObject({ algorithmName: 'SHA-512', spinCount: 1000, saltValue: bytesToBase64(SALT) });
    expect(await verifyPassword('open sesame', verifier)).toBe(true);
    expect(await verifyPassword('Open sesame', verifier)).toBe(false);
    // The transitional attribute names (cryptAlgorithmSid 14 = SHA-512) and a writer that hashed the password directly.
    const direct = { cryptAlgorithmSid: 14, cryptSpinCount: 50, salt: bytesToBase64(SALT), hash: bytesToBase64(iteratedHash('pw', { salt: SALT, spinCount: 50, legacy: false })) };
    expect(await verifyPassword('pw', direct)).toBe(true);
    expect(await verifyPassword('nope', direct)).toBe(false);
    expect(await verifyPassword('anything', { edit: 'readOnly' })).toBe(true);
    expect(await createPasswordVerifier('')).toBeNull();
  });
});

describe('protected documents', () => {
  it('opens protection, permission ranges and locked styles for editing and saves them unchanged', async () => {
    const source = protectedDocx(), { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.reviewSettings.protection).toMatchObject({ edit: 'readOnly', enforcement: true, formatting: false });
    expect(pkg.reviewSettings.lockedStyles).toEqual(['Heading1']);
    expect(pkg.reviewSettings.defaultLanguage).toBe('en-GB');
    const ranges = permissionRanges(model.paragraphs);
    expect(ranges.map(r => [model.text.slice(r.start, r.end), r.edGrp, r.ed])).toEqual([['Open', 'everyone', null], ['For Ada', null, 'ada@example.com']]);
    expect(model.bookmarks).toEqual([]);
    expect(await save(pkg, model)).toEqual(unzipSync(source));
  });

  it('keeps permission ranges through edits and writes them back', async () => {
    const { pkg, model } = await open(protectedDocx());
    model.select(model.text.indexOf('Open') + 4); model.replace(' wide');
    model.select(0); model.replace('Very ');
    const xml = strFromU8((await save(pkg, model))['word/document.xml']);
    expect(xml).toMatch(/<w:permStart w:id="1" w:edGrp="everyone"\/><w:r><w:t xml:space="preserve">Open wide<\/w:t><\/w:r><w:permEnd w:id="1"\/>/);
    expect(xml).toMatch(/<w:permStart w:id="7" w:ed="ada@example.com"\/>/);
    const again = await open(strToU8Zip(await save(pkg, model)));
    expect(permissionRanges(again.model.paragraphs).map(r => again.model.text.slice(r.start, r.end))).toEqual(['Open wide', 'For Ada']);
  });

  it('writes protection, write protection, proofing flags, markup view, language and style locks', async () => {
    const { pkg, model } = await open(protectedDocx({ settings: '' }));
    expect(pkg.reviewSettings.protection).toBeNull();
    const verifier = await createPasswordVerifier('pw', { salt: SALT, spinCount: 10 });
    pkg.reviewSettings = { ...pkg.reviewSettings, protection: { edit: 'comments', formatting: true, enforcement: true, ...verifier }, writeProtection: { recommended: true }, hideGrammaticalErrors: true, doNotTrackMoves: true, revisionView: { ...pkg.reviewSettings.revisionView, insDel: false, formatting: false }, defaultLanguage: 'fr-FR', lockedStyles: [] };
    pkg.hideSpellingErrors = true;
    const out = await save(pkg, model), settings = strFromU8(out['word/settings.xml']), styles = strFromU8(out['word/styles.xml']);
    expect(settings).toMatch(/^<\?xml|^<w:settings/);
    expect(settings.indexOf('w:writeProtection')).toBeLessThan(settings.indexOf('w:zoom'));
    expect(settings).toMatch(/<w:documentProtection w:edit="comments" w:formatting="1" w:enforcement="1" w:algorithmName="SHA-512" w:hashValue="[^"]+" w:saltValue="AAECAwQFBgcICQoLDA0ODw==" w:spinCount="10"\/>/);
    expect(settings).toMatch(/<w:hideSpellingErrors\/><w:hideGrammaticalErrors\/>.*<w:revisionView w:insDel="0" w:formatting="0"\/>.*<w:doNotTrackMoves\/><w:documentProtection/);
    expect(settings.indexOf('w:documentProtection')).toBeLessThan(settings.indexOf('w:defaultTabStop'));
    expect(styles).toMatch(/<w:lang w:val="fr-FR"\/>/);
    expect(styles).not.toMatch(/<w:locked\/>/);
    const reopened = await DocxPackage.open(zipSync(out));
    expect(reopened.reviewSettings).toMatchObject({ protection: { edit: 'comments', formatting: true, enforcement: true, spinCount: 10 }, writeProtection: { recommended: true }, hideSpellingErrors: true, hideGrammaticalErrors: true, doNotTrackMoves: true, defaultLanguage: 'fr-FR', lockedStyles: [] });
    expect(reopened.reviewSettings.revisionView).toMatchObject({ insDel: false, formatting: false, comments: true });
    expect(await verifyPassword('pw', reopened.reviewSettings.protection)).toBe(true);
    // Stopping protection keeps the restriction choices and drops enforcement and the verifier.
    reopened.reviewSettings = { ...reopened.reviewSettings, protection: { edit: 'comments', formatting: true, enforcement: false } };
    const stopped = strFromU8((await save(reopened, new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets)))['word/settings.xml']);
    expect(stopped).toMatch(/<w:documentProtection w:edit="comments" w:formatting="1" w:enforcement="0"\/>/);
  });
});

function strToU8Zip(parts) { return zipSync(parts); }

describe('enforcement', () => {
  const session = async (protection, user = {}, body) => {
    const { pkg, model } = await open(protectedDocx({ body }));
    const s = new StorySession(model, null);
    s.guard = protectionGuard(protection ?? pkg.reviewSettings.protection, user, { contentControlRanges });
    return { pkg, s, model };
  };
  const tryEdit = (s, action) => { try { s.run(action); return true; } catch (e) { if (!(e instanceof ProtectionError)) throw e; return false; } };

  it('allows edits only inside ranges that apply to the user', async () => {
    const { s, model } = await session(null, { name: 'Grace' });
    const text = model.text;
    expect(tryEdit(s, m => { m.select(0, 5); m.replace('Nope'); })).toBe(false);
    expect(model.text).toBe(text);
    expect(tryEdit(s, m => { m.select(m.text.indexOf('Open'), m.text.indexOf('Open') + 4); m.replace('Changed'); })).toBe(true);
    // Typing at either edge of a range stays inside it.
    expect(tryEdit(s, m => { const at = m.text.indexOf('Changed'); m.select(at); m.replace('['); })).toBe(true);
    expect(tryEdit(s, m => { const at = m.text.indexOf('Changed') + 7; m.select(at); m.replace(']'); })).toBe(true);
    expect(model.text.startsWith('Fixed text. [Changed] tail.')).toBe(true);
    // Ada's range is not Grace's.
    expect(tryEdit(s, m => { m.select(m.text.indexOf('For Ada')); m.replace('x'); })).toBe(false);
    expect(tryEdit(s, m => { m.select(0, 3); m.setRunFormat({ bold: true }); })).toBe(false);
  });

  it('lets a named editor edit their own range, including new paragraphs', async () => {
    const { s, model } = await session(null, { name: 'Ada', email: 'ADA@example.com' });
    expect(permissionApplies({ ed: 'ada@example.com' }, { email: 'ADA@example.com' })).toBe(true);
    expect(tryEdit(s, m => { const at = m.text.indexOf('For Ada') + 7; m.select(at); m.replace('\nSecond line'); })).toBe(true);
    expect(model.text).toContain('For Ada\nSecond line\nClosing');
    expect(tryEdit(s, m => { m.select(m.text.length); m.replace('!'); })).toBe(false);
  });

  it('allows only comments under a comments restriction', async () => {
    const { s, model } = await session({ edit: 'comments', enforcement: true });
    expect(tryEdit(s, m => { m.select(0, 5); m.addComment({ author: 'Grace', text: 'Why fixed?' }); })).toBe(true);
    expect(model.commentList).toHaveLength(1);
    expect(tryEdit(s, m => { m.select(0); m.replace('x'); })).toBe(false);
  });

  it('requires tracked changes under a tracked-changes restriction', async () => {
    const { s, model } = await session({ edit: 'trackedChanges', enforcement: true });
    expect(tryEdit(s, m => { m.select(0); m.replace('x'); })).toBe(false);
    model.trackChanges = true; model.revisionAuthor = 'Grace';
    expect(tryEdit(s, m => { m.select(0, 5); m.replace('Changed'); })).toBe(true);
    expect(model.revisions.map(r => r.type)).toEqual(['del', 'ins']);
    expect(tryEdit(s, m => m.resolveRevisions(true))).toBe(false);
  });

  it('refuses new direct formatting under a formatting restriction', async () => {
    const { s } = await session({ edit: 'none', formatting: true, enforcement: true });
    expect(tryEdit(s, m => { m.select(0); m.replace('Typed '); })).toBe(true);
    expect(tryEdit(s, m => { m.select(0, 5); m.setRunFormat({ italic: true }); })).toBe(false);
  });

  it('is inert when protection is not enforced', () => {
    expect(protectionGuard({ edit: 'readOnly', enforcement: false })).toBeNull();
    expect(protectionGuard(null)).toBeNull();
  });

  it('adds and removes permission ranges as undoable edits and saves them', async () => {
    const { pkg, model } = await open(protectedDocx({ settings: '' }));
    const at = model.text.indexOf('Closing');
    const id = addPermissionRange(model, at, at + 7, { ed: 'grace@example.com' });
    expect(id).toBe('2'); // the lowest identifier not in use (1 and 7 are)
    expect(addPermissionRange(model, at, at + 7, { ed: 'grace@example.com' })).toBe('2'); // the same range is not added twice
    expect(permissionRanges(model.paragraphs).map(r => [model.text.slice(r.start, r.end), r.ed])).toContainEqual(['Closing', 'grace@example.com']);
    const xml = strFromU8((await save(pkg, model))['word/document.xml']);
    expect(xml).toMatch(/<w:permStart w:id="2" w:ed="grace@example.com"\/><w:r><w:t xml:space="preserve">Closing<\/w:t><\/w:r><w:permEnd w:id="2"\/>/);
    expect(removePermissionRanges(model, ['2'])).toBe(1);
    expect(permissionRanges(model.paragraphs).some(r => r.id === '2')).toBe(false);
    model.undo();
    expect(permissionRanges(model.paragraphs).some(r => r.id === '2')).toBe(true);
    expect(() => addPermissionRange(model, 0, 1, {})).toThrow(/who may edit/);
  });

  it('refuses locked styles under a formatting restriction', async () => {
    const { s, model } = await session({ edit: 'none', formatting: true, enforcement: true, lockedStyles: ['Heading1'] });
    expect(tryEdit(s, m => { m.select(0); m.setParagraphStyle('Heading1'); })).toBe(false);
    expect(model.paragraphs[0].styleId).not.toBe('Heading1');
  });

  it('numbers new permission ranges after existing ones', () => {
    const paragraphs = [{ id: 'a', runs: [{ text: 'x' }], bookmarks: [permissionMarker('1', 'start', 0, 0, { edGrp: 'everyone' }), permissionMarker('1', 'end', 1, 1), permissionMarker('2', 'start', 0, 2), permissionMarker('2', 'end', 1, 3)] }];
    expect(nextPermissionId(paragraphs)).toBe('3');
  });
});
