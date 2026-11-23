// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { openParagraphDialog } from '../src/views/paragraph-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';

afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); });

// The editor numbers lines (Layout > Line Numbers) and hyphenates automatically (Layout > Hyphenation), and both
// honour these two paragraph exceptions. The tab said they were only kept for other word processors.
it('offers the line-number and hyphenation exceptions as settings that apply here, and applies them', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  let applied = null;
  openParagraphDialog({ format: { alignment: 'left', outlineLevel: 9, indentLeft: 0, indentRight: 0, firstLine: 0, spaceBefore: 0, spaceAfter: 0, lineSpacing: 1, lineRule: 'auto', mirrorIndents: false, contextualSpacing: false,
      widowControl: true, keepNext: false, keepLines: false, pageBreakBefore: false, suppressLineNumbers: false, suppressAutoHyphens: false },
    initialTab: 'breaks', apply: patch => { applied = patch; return true; } });
  const dialog = document.querySelector('form');
  expect(dialog.textContent).not.toMatch(/does not number lines|hyphenate automatically|kept in the file for other/);
  for (const name of ['Suppress line numbers', 'Don’t hyphenate']) {
    const box = [...dialog.querySelectorAll('label')].find(label => label.textContent.trim() === name)?.querySelector('input');
    box.click();
  }
  dialog.requestSubmit();
  await vi.waitFor(() => expect(applied).not.toBeNull());
  expect(applied).toEqual({ suppressLineNumbers: true, suppressAutoHyphens: true });
});
