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
  it('does not retain or announce a picture that finishes after disposal', async () => {
    let finish;
    vi.mocked(generateImage).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const create = vi.spyOn(URL, 'createObjectURL');
    const { panel, go } = setup();
    go.click();
    panel.dispose();
    panel.el.remove();
    finish({ blob: new Blob(['image'], { type: 'image/png' }), prompt: 'Late picture' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    expect(panel.el.querySelector('.gen-card')).toBe(null);
    panel.dispose();
  });

  it('does not report a late generation error after disposal', async () => {
    let fail;
    vi.mocked(generateImage).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { panel, go } = setup();
    go.click();panel.dispose();panel.el.remove();
    fail(new Error('Late generation error'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).not.toContain('Late generation error');
  });

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
