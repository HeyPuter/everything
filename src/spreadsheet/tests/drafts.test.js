import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { draftKey, saveDraft, loadDraft, clearDraft, moveDraft, listDrafts } from '../src/lib/drafts.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx } from '../src/core/io.js';

// Node ships a placeholder localStorage that jsdom does not replace; use a real in-memory one.
function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

function installMockPuter() {
  const fs = new Map();
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { code: 'subject_does_not_exist' });
  const item = (path, f) => ({ path, name: path.split('/').pop(), is_dir: !f, size: f?.size ?? null, modified: f?.modified ?? 1 });
  globalThis.puter = {
    env: 'web',
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'demo' }) },
    kv: { get: async () => null, set: async () => true },
    fs: {
      async mkdir(p) { return item(p); },
      async readdir(p) {
        const out = [...fs.entries()].filter(([k]) => k.startsWith(`${p}/`)).map(([k, f]) => item(k, f));
        if (!out.length) throw notFound(p);
        return out;
      },
      async read(p) { const f = fs.get(p); if (!f) throw notFound(p); return f.blob; },
      async write(p, blob) { fs.set(p, { blob, size: blob.size, modified: Date.now() / 1000 }); return item(p, fs.get(p)); },
      async stat(p) { if (fs.has(p)) return item(p, fs.get(p)); throw notFound(p); },
    },
    ui: {},
  };
  return fs;
}

describe('local drafts', () => {
  beforeEach(() => localStorage.clear());

  it('retains the last recoverable draft when a later edit is too large to store', () => {
    const wb = new Workbook();
    const key = draftKey('Spreadsheets/Large.xlsx');
    wb.setInput(wb.activeSheetId, 0, 0, 'recoverable work');
    expect(saveDraft(key, wb, 'Large')).toBe(true);
    const previous = loadDraft(key);
    // A cell holds what a file can hold, so the oversized book is many long cells.
    wb.setCells(wb.activeSheetId, Array.from({ length: 100 }, (_, i) => ({ r: i, c: 1, cell: { v: 'x'.repeat(30_000), f: null } })));
    expect(saveDraft(key, wb, 'Large')).toBe(false);
    expect(loadDraft(key)).toEqual(previous);
  });

  it('stores, lists, moves, and clears drafts', () => {
    const wb = new Workbook();
    wb.setInput(wb.sheets[0].id, 0, 0, 'hello');
    const key = draftKey('Spreadsheets/A.xlsx');
    expect(saveDraft(key, wb, 'A')).toBe(true);
    const back = loadDraft(key);
    expect(back.name).toBe('A');
    expect(back.workbook.sheets[0].cells['0,0'].v).toBe('hello');
    expect(listDrafts().map((d) => d.path)).toEqual(['Spreadsheets/A.xlsx']);
    moveDraft(key, draftKey('Spreadsheets/B.xlsx'));
    expect(loadDraft(key)).toBeNull();
    expect(loadDraft(draftKey('Spreadsheets/B.xlsx')).name).toBe('A');
    clearDraft(draftKey('Spreadsheets/B.xlsx'));
    expect(listDrafts()).toEqual([]);
    expect(draftKey(null, 'Untitled')).toContain('new:Untitled');
  });
});

describe('the document keeps a draft until the file holds the edits', () => {
  let fs;
  beforeAll(async () => { await workbookToXlsx(new Workbook()); });
  beforeEach(() => { localStorage.clear(); fs = installMockPuter(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

  it('recovers each unsaved workbook independently when several have the same name', async () => {
    const first = Doc.blank();
    const second = Doc.blank();
    const recovered = [];
    try {
      first.wb.setInput(first.wb.activeSheetId, 0, 0, 'First tab');
      second.wb.setInput(second.wb.activeSheetId, 0, 0, 'Second tab');
      first.writeDraft();
      second.writeDraft();
      expect(listDrafts()).toHaveLength(2);
      expect(first.draftKey).not.toBe(second.draftKey);
      for (const original of [first, second]) {
        const doc = Doc.fromDraft(original.draftKey);
        recovered.push(doc);
        expect(doc.draftKey).toBe(original.draftKey);
        expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe(original.wb.getValue(original.wb.activeSheetId, 0, 0));
      }
      const secondKey = second.draftKey;
      await recovered[0].rename('Recovered first');
      await recovered[0].save();
      expect(loadDraft(secondKey)?.workbook.sheets[0].cells['0,0'].v).toBe('Second tab');
      expect(listDrafts()).toHaveLength(1);
    } finally { for (const doc of [first, second, ...recovered]) doc.destroy(); }
  });

  it.each([
    [null, 'writeDraft'], [null, 'destroy'],
    ['Spreadsheets/Shared.xlsx', 'writeDraft'], ['Spreadsheets/Shared.xlsx', 'destroy'],
  ])('does not clear another document\'s draft at %s during %s', (path, action) => {
    const clean = new Doc({ path });
    const editing = new Doc({ path });
    try {
      editing.wb.setInput(editing.wb.activeSheetId, 0, 0, 'Unsaved in another tab');
      editing.writeDraft();
      const draft = loadDraft(editing.draftKey);
      clean[action]();
      expect(loadDraft(editing.draftKey)).toEqual(draft);
    } finally { clean.destroy(); editing.destroy(); }
  });

  it.each([null, 'Spreadsheets/Shared.xlsx'])('keeps another tab\'s newer draft when saving %s', async (path) => {
    const saving = new Doc({ path });
    const editing = new Doc({ path });
    try {
      saving.wb.setInput(saving.wb.activeSheetId, 0, 0, 'Save this');
      saving.writeDraft();
      editing.wb.setInput(editing.wb.activeSheetId, 0, 0, 'Keep this unsaved edit');
      editing.writeDraft();
      // Where the other tab keeps its edits: beside the saving tab's draft, when both have the file's key (see writeDraft).
      const key = editing._ownDraftKey;
      const draft = loadDraft(key);
      await saving.save();
      expect(saving.wb.dirty).toBe(false);
      expect(loadDraft(key)).toEqual(draft);
    } finally { saving.destroy(); editing.destroy(); }
  });

  it('discards only the recovery snapshot that was offered', () => {
    const reopened = new Doc({ path: 'Spreadsheets/Shared.xlsx' });
    const editing = new Doc({ path: reopened.path });
    try {
      editing.wb.setInput(editing.wb.activeSheetId, 0, 0, 'Offered for recovery');
      editing.writeDraft();
      reopened.recoverable = loadDraft(editing.draftKey);
      editing.wb.setInput(editing.wb.activeSheetId, 0, 0, 'Newer work');
      editing.writeDraft();
      const newer = loadDraft(editing.draftKey);
      reopened.discardDraft();
      expect(reopened.recoverable).toBeNull();
      expect(loadDraft(editing.draftKey)).toEqual(newer);
    } finally { reopened.destroy(); editing.destroy(); }
  });

  it.each(['rename', 'saveAs'])('does not move another tab\'s draft during %s', async (action) => {
    const changing = Doc.blank();
    let editing;
    try {
      changing.wb.setInput(changing.wb.activeSheetId, 0, 0, 'My work');
      changing.writeDraft();
      // Reopen the same draft in the second tab. Independent new documents
      // now have different keys even when their titles are identical.
      editing = Doc.fromDraft(changing.draftKey);
      editing.wb.setInput(editing.wb.activeSheetId, 0, 0, 'Other work');
      editing.writeDraft();
      const key = editing.draftKey;
      const draft = loadDraft(key);
      expect(await changing[action]('Another name')).toBeNull();
      expect(loadDraft(key)).toEqual(draft);
      expect(loadDraft(changing.draftKey)).toBeNull();
    } finally { changing.destroy(); editing?.destroy(); }
  });

  it.each(['restore', 'discard'])('can %s a legacy draft without a revision ID', async (action) => {
    const doc = new Doc({ path: 'Spreadsheets/Legacy.xlsx' });
    try {
      const wb = new Workbook();
      wb.setInput(wb.activeSheetId, 0, 0, 'Legacy recovery');
      saveDraft(doc.draftKey, wb, 'Legacy');
      doc.recoverable = loadDraft(doc.draftKey);
      expect(doc.recoverable.revision).toBeUndefined();
      if (action === 'restore') {
        expect(doc.restoreDraft()).toBe(true);
        expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Legacy recovery');
        // Save immediately, before the restored book writes another local draft.
        await doc.save();
        expect(doc.wb.dirty).toBe(false);
      } else doc.discardDraft();
      expect(loadDraft(doc.draftKey)).toBeNull();
    } finally { doc.destroy(); }
  });

  it('moves an unsaved document draft when renamed and clears it after saving', async () => {
    const doc = Doc.blank();
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Unsaved edit');
      expect(doc.writeDraft()).toBe(true);
      const oldKey = doc.draftKey;
      expect(await doc.rename('Named draft')).toBeNull();
      expect(doc.draftKey).not.toBe(oldKey);
      expect(loadDraft(doc.draftKey)?.workbook.sheets[0].cells['0,0'].v).toBe('Unsaved edit');
      expect(loadDraft(oldKey)).toBeNull();
      await doc.save();
      expect(doc.path).toBe('Spreadsheets/Named draft.xlsx');
      expect(listDrafts()).toEqual([]);
    } finally { doc.destroy(); }
  });

  it('offers edits drafted within the first second after a save and preserves an undecided draft', async () => {
    const original = Doc.blank();
    original.wb.setInput(original.wb.activeSheetId, 0, 0, 'Saved');
    await original.save();
    await vi.advanceTimersByTimeAsync(100);
    original.wb.setInput(original.wb.activeSheetId, 0, 0, 'Unsaved');
    original.writeDraft();
    original.destroy();
    const reopened = await Doc.fromPath(original.path);
    try {
      expect(reopened.recoverable).toBeTruthy();
      reopened.writeDraft();
      expect(loadDraft(reopened.draftKey)).toBeTruthy();
      reopened.destroy();
      expect(loadDraft(reopened.draftKey)).toBeTruthy();
      reopened.discardDraft();
      expect(loadDraft(reopened.draftKey)).toBeNull();
    } finally { reopened.destroy(); }
  });

  it('does not discard a draft when the remote modification time is unavailable', async () => {
    const original = Doc.blank();
    original.wb.setInput(original.wb.activeSheetId, 0, 0, 'Saved');
    await original.save();
    original.wb.setInput(original.wb.activeSheetId, 0, 0, 'Unsaved');
    original.writeDraft();
    original.destroy();
    globalThis.puter.fs.stat = async () => { throw new Error('Temporary stat failure'); };
    const reopened = await Doc.fromPath(original.path);
    try { expect(reopened.recoverable).toBeTruthy(); }
    finally { reopened.destroy(); }
  });

  it('writes a draft after an edit, clears it after a save, and offers a newer draft on reopen', async () => {
    const path = 'Spreadsheets/Plan.xlsx';
    const wb = new Workbook();
    const doc = new Doc({ wb, name: 'Plan', path });
    // The file is on the drive, as it is for any document that knows when it was last written.
    fs.set(path, { blob: new Blob(['x']), size: 1, modified: Date.now() / 1000 });
    doc.remoteModified = Date.now();
    wb.setInput(wb.sheets[0].id, 0, 0, 'first');
    await vi.advanceTimersByTimeAsync(700);
    expect(loadDraft(doc.draftKey)?.workbook.sheets[0].cells['0,0'].v).toBe('first');
    await vi.advanceTimersByTimeAsync(2000); // autosave lands
    expect(fs.has(path)).toBe(true);
    expect(doc.status).toBe('saved');
    expect(loadDraft(doc.draftKey)).toBeNull();

    // An edit whose save never happens (the tab closed) leaves a draft behind…
    wb.setInput(wb.sheets[0].id, 0, 1, 'second');
    await vi.advanceTimersByTimeAsync(700);
    doc.destroy();
    expect(loadDraft(doc.draftKey)).toBeTruthy();

    // …which reopening the file offers back, newer than the file by more than the slack.
    await vi.advanceTimersByTimeAsync(3000);
    const raw = JSON.parse(localStorage.getItem(doc.draftKey));
    raw.savedAt = Date.now() + 10000;
    localStorage.setItem(doc.draftKey, JSON.stringify(raw));
    const reopened = await Doc.fromPath(path);
    expect(reopened.recoverable).toBeTruthy();
    expect(reopened.wb.getValue(reopened.wb.sheets[0].id, 0, 1)).toBe(null);
    expect(reopened.restoreDraft()).toBe(true);
    expect(reopened.wb.getValue(reopened.wb.sheets[0].id, 0, 1)).toBe('second');
    expect(reopened.wb.dirty).toBe(true);
    expect(reopened.recoverable).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reopened.status).toBe('saved');
    expect(loadDraft(reopened.draftKey)).toBeNull();
    reopened.destroy();

    // A draft older than the file is stale and dropped quietly.
    saveDraft(draftKey(path), new Workbook(), 'Plan');
    const older = JSON.parse(localStorage.getItem(draftKey(path)));
    older.savedAt = 1000;
    localStorage.setItem(draftKey(path), JSON.stringify(older));
    const again = await Doc.fromPath(path);
    expect(again.recoverable).toBeNull();
    expect(loadDraft(draftKey(path))).toBeNull();
    again.destroy();
  });
});
