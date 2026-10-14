import { afterEach, describe, expect, it, vi } from 'vitest';
import * as P from '../src/lib/puter.js';
import { parseAppHash, fileLink } from '../src/lib/links.js';

const withSDK = (fs, extra = {}) => vi.stubGlobal('puter', { fs, auth: { getUser: async () => ({ username: 'me' }) }, ...extra });
afterEach(() => vi.unstubAllGlobals());

describe('sharing through Puter', () => {
  it('shares with a person and reports whether the access is new', async () => {
    const share = vi.fn().mockResolvedValue([{ uid: 's1', holder: 'ana', mode: 'write', isNew: false }]);
    withSDK({ share, getShares() {} });
    expect(P.canShare()).toBe(true);
    const row = await P.shareFile('Spreadsheets/Plan.xlsx', '  ana ', 'write');
    expect(share).toHaveBeenCalledWith('Spreadsheets/Plan.xlsx', 'ana', 'write');
    expect(row).toMatchObject({ who: 'user', label: 'ana', recipient: 'ana', mode: 'write', isNew: false });
  });

  it('reports an invite by the address it went to, and withdraws it by that address', async () => {
    withSDK({ share: async () => [{ holder: null, pending: true, recipientEmail: 'new@example.com', mode: 'read' }], getShares() {} });
    expect(await P.shareFile('a.xlsx', 'new@example.com')).toMatchObject({ who: 'invite', pending: true, label: 'new@example.com', recipient: 'new@example.com' });
  });

  it('turns a refusal into words for the dialog, keeping its code', async () => {
    withSDK({ share: async () => { throw { code: 'user_does_not_exist', message: 'no' }; }, getShares() {} });
    await expect(P.shareFile('a.xlsx', 'ghost')).rejects.toMatchObject({ code: 'user_does_not_exist', message: expect.stringMatching(/No Puter account/) });
    expect(P.shareProblem({ message: 'Something odd' })).toBe('Something odd');
    // Puter's own words for these say what went wrong, not what to do about it.
    expect(P.shareProblem({ code: 'account_is_not_verified', message: 'Account email is not verified' })).toMatch(/Confirm your email address/);
    expect(P.shareProblem({ code: 'too_many_requests', message: 'Too many requests.' })).toMatch(/Wait a moment/);
  });

  it('lists people first and leaves links and folder access out of what may be withdrawn', async () => {
    withSDK({
      getShares: async () => [
        { anyone: true, holder: null, mode: 'read' },
        { holder: 'zoe', mode: 'read', inheritedFrom: '/me/Work' },
        { holder: null, pending: true, recipientEmail: 'x@example.com', mode: 'read' },
        { holder: 'bo', mode: 'write' },
      ],
    });
    const rows = await P.shareAccess('a.xlsx');
    expect(rows.map((r) => r.label)).toEqual(['bo', 'zoe', 'x@example.com', 'Anyone with the link']);
    expect(rows.map((r) => r.recipient)).toEqual(['bo', null, 'x@example.com', null]);
  });

  it('names a team by its name, else its handle', async () => {
    withSDK({
      getShares: async () => [
        { holder: null, holderTeam: { uid: 't1', name: 'Finance', handle: 'fin' }, mode: 'read' },
        { holder: null, holderTeam: { uid: 't2', name: null, handle: 'ops' }, mode: 'write' },
        { holder: null, holderTeam: { uid: 't3', name: null, handle: null }, mode: 'read' },
      ],
    });
    expect((await P.shareAccess('a.xlsx')).map((r) => [r.who, r.label])).toEqual([['team', 'A team'], ['team', 'Finance'], ['team', 'ops']]);
  });

  it('pages through what is shared with the user until the cursor is gone, keeping only spreadsheet files', async () => {
    const listShared = vi.fn()
      .mockResolvedValueOnce({ items: [{ name: 'Old.xlsx', path: '/ana/u1/Old.xlsx', entryUid: 'u1', mode: 'read', owner: 'ana', modified: 1 }], cursor: 'next' })
      .mockResolvedValueOnce({ items: [{ name: 'Photos', isDir: true, path: '/ana/u2/Photos' }, { name: 'notes.txt', path: '/ana/u3/notes.txt' }, { name: 'New.csv', path: '/bo/u4/New.csv', mode: 'write', issuer: 'bo', modified: 9 }] });
    withSDK({ listShared });
    const files = await P.listSharedWithMe();
    expect(listShared).toHaveBeenLastCalledWith({ limit: 50, cursor: 'next' });
    expect(files.map((f) => [f.name, f.owner, f.mode])).toEqual([['New.csv', 'bo', 'write'], ['Old.xlsx', 'ana', 'read']]);
  });

  it('leaves a share as the signed-in user', async () => {
    const unshare = vi.fn().mockResolvedValue({ revoked: 1 });
    withSDK({ unshare });
    expect(await P.leaveShare('/ana/u1/Old.xlsx')).toBe(1);
    expect(unshare).toHaveBeenCalledWith('/ana/u1/Old.xlsx', 'me');
  });

  it('builds a Puter link only inside the desktop', async () => {
    const getShareLink = vi.fn().mockResolvedValue('https://puter.com/app/spreadsheet?file=u1');
    withSDK({ getShareLink }, { env: 'web' });
    expect(await P.puterShareLink('a.xlsx')).toBeNull();
    withSDK({ getShareLink }, { env: 'app' });
    expect(await P.puterShareLink('a.xlsx')).toBe('https://puter.com/app/spreadsheet?file=u1');
  });
});

describe('links to a file by its id', () => {
  it('round-trips through the address', () => {
    const url = fileLink({ origin: 'https://sheet.example', pathname: '/' }, 'a b/c');
    expect(url).toBe('https://sheet.example/#/file/a%20b%2Fc');
    expect(parseAppHash(url.slice(url.indexOf('#')))).toEqual({ route: 'file', id: 'a b/c', range: null });
    expect(parseAppHash('#/file/')).toEqual({ route: 'home' });
  });

  it('can open the file at a range', () => {
    const url = fileLink({ origin: 'https://sheet.example', pathname: '/' }, 'u1', "'Q3 plan'!B4");
    expect(url).toBe("https://sheet.example/#/file/u1?range='Q3%20plan'!B4");
    expect(parseAppHash(url.slice(url.indexOf('#')))).toEqual({ route: 'file', id: 'u1', range: "'Q3 plan'!B4" });
  });
});

describe('what is shared with the user, when several people shared the same file', () => {
  it('lists the file once, at the most the shares allow', async () => {
    const listShared = vi.fn().mockResolvedValue({ items: [
      { name: 'Team.xlsx', path: '/ana/u1/Team.xlsx', entryUid: 'u1', mode: 'read', owner: 'ana', issuer: 'bo', modified: 5 },
      { name: 'Team.xlsx', path: '/ana/u1/Team.xlsx', entryUid: 'u1', mode: 'write', owner: 'ana', issuer: 'ana', modified: 5 },
      { name: 'Other.xlsx', path: '/ana/u2/Other.xlsx', entryUid: 'u2', mode: 'read', owner: 'ana', modified: 1 },
    ] });
    withSDK({ listShared });
    const files = await P.listSharedWithMe();
    expect(files.map((f) => [f.name, f.mode])).toEqual([['Team.xlsx', 'write'], ['Other.xlsx', 'read']]);
  });
});

describe('the access the user has to a file shared with them', () => {
  it('is read from what is shared with them, by id or by address', async () => {
    withSDK({ listShared: async () => ({ items: [{ name: 'A.xlsx', path: '/ana/u1/A.xlsx', entryUid: 'u1', mode: 'read' }, { name: 'B.xlsx', path: '/ana/u2/B.xlsx', entryUid: 'u2', mode: 'write' }] }) });
    expect(await P.sharedModeOf({ path: '/elsewhere/A.xlsx', uid: 'u1' })).toBe('read');
    expect(await P.sharedModeOf({ path: '/ana/u2/B.xlsx' })).toBe('write');
    expect(await P.sharedModeOf({ path: '/me/Spreadsheets/C.xlsx', uid: 'u3' })).toBeNull();
    expect([P.canWriteMode('read'), P.canWriteMode('write'), P.canWriteMode('manage')]).toEqual([false, true, true]);
  });
});
