// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ toasts: [], modals: [], written: [], here: true }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn((message, options) => { calls.toasts.push([message, options]); return { dismiss() {} }; }) }));
vi.mock('../src/ui/modal.js', () => ({ openModal: vi.fn((options) => { calls.modals.push(options); return { close() {} }; }) }));
vi.mock('../src/lib/session.js', () => ({ session: { signedOut: false, signIn: async () => true } }));
vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    uniqueName: async (name) => name,
    // The user moves on while the first file is being written.
    writeFile: vi.fn(async (path) => { calls.written.push(path); calls.here = false; if (/broken/.test(path)) throw new Error('Disk full'); }),
  };
});

import { importFiles, nothingImportable } from '../src/lib/importfiles.js';
import { session } from '../src/lib/session.js';

beforeEach(() => { calls.toasts.length = 0; calls.modals.length = 0; calls.written.length = 0; calls.here = true; });
afterEach(() => { vi.clearAllMocks(); });

const docx = (name) => new File(['PK'], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

it('names the file that could not be imported even after the user moved on', async () => {
  const openFile = vi.fn();
  await importFiles([docx('Good.docx'), docx('broken.docx')], { openFile, stillHere: () => calls.here });
  expect(openFile).not.toHaveBeenCalled();
  expect(calls.toasts.map(([message]) => message)).toEqual(['Imported 1 of 2 files']);
  expect(calls.modals.length).toBe(1);
  expect(calls.modals[0].title).toBe('Import details');
  expect(calls.modals[0].content.textContent).toBe('broken.docx: Disk full');
});

it('keeps the extension of templates and macro-enabled documents written into the folder', async () => {
  await importFiles([docx('Plan.docx'), docx('Letter.dotx'), docx('Macros.docm')], { openFile: vi.fn() });
  // Under .docx, Word refuses a template's or macro-enabled document's content.
  expect(calls.written).toEqual(['Documents/Plan.docx', 'Documents/Letter.dotx', 'Documents/Macros.docm']);
});

it('reports the same details when the user stayed', async () => {
  const onImported = vi.fn();
  await importFiles([docx('Good.docx'), docx('broken.docx')], { openFile: vi.fn(), onImported });
  expect(calls.toasts.map(([message]) => message)).toEqual(['Imported 1 of 2 documents']);
  expect(calls.modals.map((m) => m.content.textContent)).toEqual(['broken.docx: Disk full']);
  expect(onImported).toHaveBeenCalled();
});

it('opens the first of several text files without asking a signed-out user to sign in', async () => {
  session.signedOut = true;
  const signIn = vi.spyOn(session, 'signIn');
  try {
    const openFile = vi.fn();
    const text = (name) => new File(['# Hi'], name, { type: 'text/markdown' });
    await importFiles([text('a.md'), text('b.md')], { openFile });
    // Nothing is written to the cloud for text files, so no session is needed.
    expect(signIn).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.md' }));
    expect(calls.toasts.map(([message]) => message).join(' ')).not.toContain('Sign in');
    // DOCX files still need the session.
    openFile.mockClear();
    signIn.mockResolvedValue(false);
    await importFiles([docx('Good.docx'), text('c.md')], { openFile });
    expect(signIn).toHaveBeenCalled();
    expect(calls.toasts.map(([message]) => message)).toContain('Sign in to Puter to import several files at once');
  } finally { session.signedOut = false; signIn.mockRestore(); }
});

it('words the "nothing importable" message for a drop or for the file dialog', async () => {
  const log = new File(['x'], 'photo.png', { type: 'image/png' });
  expect(nothingImportable([log])).toBe('Drop DOCX, Hanword (.hwp, .hwpx), Markdown, HTML, or text files to open them');
  expect(nothingImportable([log], { picked: true })).toBe('That file cannot be imported. Choose DOCX, Hanword (.hwp, .hwpx), Markdown, HTML, or text files');
  expect(nothingImportable([log, log], { picked: true })).toBe('Those files cannot be imported. Choose DOCX, Hanword (.hwp, .hwpx), Markdown, HTML, or text files');
  await importFiles([log], { openFile: vi.fn(), nothingMessage: nothingImportable([log], { picked: true }) });
  expect(calls.toasts.map(([message]) => message)).toEqual(['That file cannot be imported. Choose DOCX, Hanword (.hwp, .hwpx), Markdown, HTML, or text files']);
});
