import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplatePreview } from '../src/ui/template-preview.js';
import { openTemplateDialog, templateCard } from '../src/ui/home-templates.js';
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

function enter(card) {
  card.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
}

function frameStep() {
  const now = performance.now() + 16;
  for (const [id, callback] of [...frames]) {
    if (!frames.has(id)) continue;
    frames.delete(id);
    callback(now);
  }
}

describe('template card playback', () => {
  it('stops both animation loops when an animating card is removed', async () => {
    vi.spyOn(TemplatePreview.prototype, 'ready').mockResolvedValue();
    const play = vi.spyOn(TemplatePreview.prototype, 'play');
    const card = templateCard(TEMPLATES[0], { onChoose: vi.fn() });
    document.body.append(card);
    try {
      enter(card);
      const preview = play.mock.contexts[0];
      expect(frames.size).toBe(2);
      card.remove();
      frameStep();
      expect(preview.raf).toBe(0);
      expect(frames.size).toBe(0);
      // This preview is cached: a later card must inherit its poster, not the last animated frame.
      expect(preview.draw).toHaveBeenLastCalledWith(preview.poster);
    } finally {
      card.dispatchEvent(new Event('pointerleave'));
    }
  });

  it('does not stop another active card when an inactive copy gets pointerleave', () => {
    vi.spyOn(TemplatePreview.prototype, 'ready').mockResolvedValue();
    const play = vi.spyOn(TemplatePreview.prototype, 'play');
    const first = templateCard(TEMPLATES[1], { onChoose: vi.fn() });
    const other = templateCard(TEMPLATES[1], { onChoose: vi.fn() });
    document.body.append(first, other);
    try {
      enter(first);
      const preview = play.mock.contexts[0];
      other.dispatchEvent(new Event('pointerleave'));
      expect(preview.raf).not.toBe(0);
      first.dispatchEvent(new Event('pointerleave'));
      expect(preview.raf).toBe(0);
      expect(frames.size).toBe(0);
    } finally {
      first.dispatchEvent(new Event('pointerleave'));
      other.dispatchEvent(new Event('pointerleave'));
    }
  });

  it('keeps a newly active copy playing when the previous card is removed', () => {
    vi.spyOn(TemplatePreview.prototype, 'ready').mockResolvedValue();
    const play = vi.spyOn(TemplatePreview.prototype, 'play');
    const first = templateCard(TEMPLATES[2], { onChoose: vi.fn() });
    const other = templateCard(TEMPLATES[2], { onChoose: vi.fn() });
    document.body.append(first, other);
    try {
      enter(first);
      enter(other);
      const preview = play.mock.contexts[0];
      first.remove();
      frameStep();
      expect(preview.raf).not.toBe(0);
      other.dispatchEvent(new Event('pointerleave'));
      expect(preview.raf).toBe(0);
      expect(frames.size).toBe(0);
    } finally {
      first.dispatchEvent(new Event('pointerleave'));
      other.dispatchEvent(new Event('pointerleave'));
    }
  });
});
