import { describe, expect, it } from 'vitest';
import { fileLinkPatch, fileLinks, hasFileLink, isLinkKey, linkKey, parseLinkKey } from '../../src/shared/file-links.js';
import { applyPatch, authorizeOperation, validateOperation } from '../../src/shared/operations.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { fileParts } from '../../src/lib/transfer/export.js';

const RES = { t: 'res', id: 'a'.repeat(16) };
const EXP = { t: 'exp', id: 'b'.repeat(16) };
const MSG = { t: 'msg', id: 'c'.repeat(16) };
const META = { t: 'meta', id: 'meta' };
const UID = '11111111-1111-4111-8111-111111111111';
const base = { id: 'f'.repeat(16), name: 'pass.pdf', mime: 'application/pdf', size: 10, sha256: 'e'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, v: '0000000001:000000:aaaaaaaaaaaaaaaa', rev: 1, upd: 1, by: UID, cr: 1 };
const op = (patch) => ({ opId: 'p'.repeat(16), t: 'file', id: base.id, ...patch });

describe('link keys', () => {
  it('round-trips ids, uuids and the cover', () => {
    for (const link of [RES, META, { t: 'entry', id: UID }]) expect(parseLinkKey(linkKey(link))).toEqual(link);
  });
  it('refuses malformed keys', () => {
    for (const key of ['res', '_x', 'res_', 'res_short', 'Res_aaaaaaaaaaaaaaaa', 'res.x_aaaaaaaaaaaaaaaa', 'meta_other', 42]) expect(isLinkKey(key)).toBe(false);
  });
});

describe('reading both forms', () => {
  it('merges the old list and the paths without duplicates', () => {
    const file = { ...base, links: [RES, EXP], linked: { [linkKey(EXP)]: true, [linkKey(MSG)]: true } };
    expect(fileLinks(file)).toEqual([RES, EXP, MSG]);
    expect(hasFileLink(file, RES)).toBe(true);
    expect(hasFileLink(file, MSG)).toBe(true);
    expect(hasFileLink(file, META)).toBe(false);
  });
  it('ignores junk in either form', () => {
    expect(fileLinks({ links: [null, { t: 'res' }], linked: { bad: true, [linkKey(RES)]: false } })).toEqual([]);
    expect(fileLinks(null)).toEqual([]);
  });
});

describe('fileLinkPatch', () => {
  it('adds one path per new link and skips links already present in either form', () => {
    const file = { ...base, links: [RES] };
    expect(fileLinkPatch(file, { add: [RES, EXP] })).toEqual({ set: { [`linked.${linkKey(EXP)}`]: true } });
    expect(fileLinkPatch({ ...file, linked: { [linkKey(EXP)]: true } }, { add: [EXP] })).toBeNull();
  });

  it('removes a path, and rewrites the old list only when it holds the link', () => {
    const file = { ...base, links: [RES, EXP], linked: { [linkKey(MSG)]: true } };
    expect(fileLinkPatch(file, { remove: [MSG] })).toEqual({ unset: [`linked.${linkKey(MSG)}`] });
    expect(fileLinkPatch(file, { remove: [RES] })).toEqual({ set: { links: [EXP] } });
    expect(fileLinkPatch({ ...base, links: [RES], linked: { [linkKey(RES)]: true } }, { remove: [RES] })).toEqual({ unset: [`linked.${linkKey(RES)}`, 'links'] });
    expect(fileLinkPatch(file, { remove: [META] })).toBeNull();
  });

  it('produces patches the shared rules accept and apply', () => {
    const file = { ...base, links: [RES] };
    const add = op(fileLinkPatch(file, { add: [EXP, META] }));
    expect(() => validateOperation(add)).not.toThrow();
    expect(authorizeOperation(add, { role: 'editor', uid: UID, entity: file })).toBe(true);
    const linked = applyPatch('trip', 'file', file, add);
    expect(fileLinks(linked)).toEqual([RES, EXP, META]);
    const remove = op(fileLinkPatch(linked, { remove: [RES, EXP] }));
    const after = applyPatch('trip', 'file', linked, remove);
    expect(after.links).toBeUndefined();
    expect(fileLinks(after)).toEqual([META]);
    expect(() => authorizeOperation(add, { role: 'viewer', uid: UID, entity: file })).toThrow();
  });

  it('keeps the schema strict about link paths', () => {
    expect(() => validateOperation(op({ set: { 'linked.res_short': true } }))).toThrow();
    expect(() => validateOperation(op({ set: { [`linked.${linkKey(RES)}`]: 1 } }))).toThrow();
    expect(() => validateEntity('trip', 'file', { ...base, linked: { [linkKey(RES)]: true } }, { server: true })).not.toThrow();
  });
});

describe('ownership transfer', () => {
  it('sends both forms as one list, which older workers accept', () => {
    const [[item]] = fileParts([{ ...base, links: [RES], linked: { [linkKey(EXP)]: true }, star: true }], { [base.id]: 'copied' });
    expect(item).toEqual({ id: base.id, links: [RES, EXP], star: true });
  });
});
