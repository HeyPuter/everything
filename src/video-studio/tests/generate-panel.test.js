import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePanel } from '../src/ui/panels/generate.js';
import { generateImage } from '../src/media/imagegen.js';
import { EditorStore } from '../src/model/store.js';
import { createProject } from '../src/model/project.js';

vi.mock('../src/media/imagegen.js', async (original) => ({ ...(await original()), generateImage: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(generateImage).mockReset();
  document.body.replaceChildren();
});

function setup() {
  vi.stubGlobal('puter', { ai: {} });
  const ctx = { store: new EditorStore(createProject()), library: { backend: { kind: 'puter' } }, actions: {} };
  const panel = generatePanel(ctx);
  document.body.append(panel.el);
  const text = panel.el.querySelector('textarea');
  text.value = 'A forest';
  text.dispatchEvent(new Event('input'));
  return { panel, text, go: panel.el.querySelector('.tts-actions button') };
}

describe('picture generation panel', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not generate while a prompt is being composed (%j)', async (composition) => {
    vi.mocked(generateImage).mockResolvedValue({ blob: new Blob(['image'], { type: 'image/png' }), prompt: 'A forest' });
    const { panel, text } = setup();
    try {
      const e = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true, ...composition });
      text.dispatchEvent(e);
      expect(generateImage).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(panel.el.querySelector('.gen-card')).toBeTruthy());
      expect(generateImage).toHaveBeenCalledTimes(1);
    } finally { panel.dispose(); }
  });
});
