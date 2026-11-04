// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { openParagraphDialog } from '../src/views/paragraph-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';

afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); });

it('shows Thai Distributed in the Paragraph dialog for a paragraph that has it, and keeps it when the dialog is accepted', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  let applied = null;
  openParagraphDialog({ format: { alignment: 'thaiDistribute', outlineLevel: 9, indentLeft: 0, indentRight: 0, firstLine: 0, spaceBefore: 0, spaceAfter: 0, lineSpacing: 1, lineRule: 'auto' }, apply: patch => { applied = patch; return true; } });
  const alignment = document.querySelector('select[aria-label="Alignment"]');
  expect(alignment.value).toBe('thaiDistribute');
  expect(alignment.selectedOptions[0].textContent).toBe('Thai Distributed');
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(applied).not.toBeNull());
  expect(applied.alignment).toBeUndefined();
  // Other paragraphs are not offered it.
  closeAllModals();
  openParagraphDialog({ format: { alignment: 'both', outlineLevel: 9 }, apply: () => true });
  const latest = [...document.querySelectorAll('select[aria-label="Alignment"]')].at(-1);
  expect([...latest.options].map(o => o.value)).toEqual(['left', 'center', 'right', 'both', 'distribute']);
});
