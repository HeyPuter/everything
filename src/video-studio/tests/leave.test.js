// Leaving with work not stored yet: one question, and a note while uploads finish.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { confirmLeave, finishUploads } from '../src/ui/leave.js';

const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...(dialog()?.querySelectorAll('button') || [])].find((b) => b.textContent === label);
const toasts = () => [...document.querySelectorAll('.toast:not(.leaving)')].map((t) => t.textContent);

beforeEach(() => document.body.replaceChildren());

describe('confirmLeave', () => {
  it('names what would be lost, focuses Stay and resolves the choice', async () => {
    const library = { backend: { kind: 'puter' } };
    const asked = confirmLeave(library, { edits: true, media: 2 });
    expect(dialog().textContent).toMatch(/Your latest changes and 2 media files couldn't be saved to your Puter cloud\. If you leave now, they will be lost/);
    expect(document.activeElement).toBe(button('Stay'));
    button('Stay').click();
    expect(await asked).toBe(false);
    const again = confirmLeave({ backend: { kind: 'local' } }, { media: 1 });
    expect(dialog().textContent).toMatch(/1 media file couldn't be saved in this browser\. If you leave now, it will be lost/);
    button('Leave anyway').click();
    expect(await again).toBe(true);
  });
});

describe('finishUploads', () => {
  it('says files are still uploading while it waits, and resolves how many were not stored', async () => {
    let done;
    const library = { unsavedMedia: 2, flushUploads: () => new Promise((r) => (done = r)) };
    const waiting = finishUploads(library);
    expect(toasts().join()).toMatch(/Finishing 2 media uploads/);
    library.unsavedMedia = 1;
    done(false);
    expect(await waiting).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(toasts().join()).not.toMatch(/Finishing/);
  });

  it('says nothing with nothing to upload', async () => {
    const flushUploads = vi.fn(async () => true);
    expect(await finishUploads({ unsavedMedia: 0, flushUploads })).toBe(0);
    expect(toasts()).toEqual([]);
  });
});
