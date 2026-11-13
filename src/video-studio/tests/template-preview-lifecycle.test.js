import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplatePreview } from '../src/ui/template-preview.js';
import { openTemplateDialog } from '../src/ui/home-templates.js';
import { TEMPLATES } from '../src/model/templates.js';
import { mockContext } from './canvas-mock.js';

let frames;
beforeEach(() => {
  document.body.replaceChildren();
  frames = new Map();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => mockContext());
  vi.spyOn(TemplatePreview.prototype, 'draw').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('template dialog playback', () => {
  it('does not restart animation when readiness resolves after closing the dialog', async () => {
    let ready;
    vi.spyOn(TemplatePreview.prototype, 'ready').mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const play = vi.spyOn(TemplatePreview.prototype, 'play');
    const dialog = openTemplateDialog(TEMPLATES[0], { onUse: vi.fn() });
    try {
      dialog.close();
      ready();
      await Promise.resolve();
      await Promise.resolve();
      expect(play).not.toHaveBeenCalled();
    } finally {
      dialog.close();
    }
  });

  it('plays a ready, open dialog and stops when it closes', async () => {
    vi.spyOn(TemplatePreview.prototype, 'ready').mockResolvedValue();
    const play = vi.spyOn(TemplatePreview.prototype, 'play');
    const dialog = openTemplateDialog(TEMPLATES[0], { onUse: vi.fn() });
    try {
      await Promise.resolve();
      expect(play).toHaveBeenCalledTimes(1);
      const preview = play.mock.contexts[0];
      expect(frames.has(preview.raf)).toBe(true);
      const animation = preview.raf;
      dialog.close();
      expect(preview.raf).toBe(0);
      expect(frames.has(animation)).toBe(false);
    } finally {
      dialog.close();
    }
  });
});
