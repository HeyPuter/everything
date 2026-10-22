// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openScriptGallery } from '../src/ui/script-gallery.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';
import { Workbook } from '../src/core/workbook.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(() => ({ dismiss() {} })) }));

// Automate ▸ All Scripts lists My Scripts from the drive. One that could not be read when Run or Add to workbook was
// pressed (deleted or renamed from another window since the list was read, or the network gone) did nothing at all:
// the gallery closed and the failure went unreported, an unhandled rejection. It now says so.
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); toast.mockClear(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const settle = () => new Promise((r) => setTimeout(r, 0));

for (const label of ['Run', 'Add to workbook']) {
  it(`says so when a script of My Scripts cannot be read for ${label}`, async () => {
    const actions = {
      run: vi.fn(), add: vi.fn(), open: vi.fn(), newScript: vi.fn(), record: vi.fn(),
      library: { list: async () => [{ name: 'Tidy', path: '/demo/Scripts/Tidy.js' }], read: vi.fn(async () => { throw new Error('No such file'); }), remove: vi.fn() },
    };
    openScriptGallery(new Workbook(), actions);
    await settle();
    const card = document.querySelector('.sg-card[aria-label="Tidy"]');
    [...card.querySelectorAll('button')].find((b) => b.textContent === label).click();
    await settle();
    expect(actions.run).not.toHaveBeenCalled();
    expect(actions.add).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Tidy.*could not be read.*No such file/), expect.anything());
  });
}
