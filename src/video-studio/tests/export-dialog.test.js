import { describe, it, expect, beforeEach, vi } from 'vitest';
import { US } from '../src/lib/time.js';
import { createProject, makeClip } from '../src/model/project.js';

vi.mock('../src/engine/exporter.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    detectCapabilities: vi.fn(async () => ({ video: ['avc', 'vp9'], audio: ['aac', 'opus'], audioFormats: ['wav', 'm4a', 'ogg'] })),
    renderStill: vi.fn(async () => null),
    exportProject: vi.fn(real.exportProject),
  };
});

const { openExportDialog } = await import('../src/ui/export-dialog.js');
const { exportProject, detectCapabilities } = await import('../src/engine/exporter.js');

function ctxWith(project) {
  return { store: { project, time: 0 }, library: { backend: { kind: 'opfs' } }, account: { user: null } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('export dialog', () => {
  it('warns and holds Export when the format cannot carry sound in this browser', async () => {
    detectCapabilities.mockResolvedValueOnce({ video: ['avc', 'vp9'], audio: ['opus'], audioFormats: ['wav', 'ogg'] });
    const p = createProject({ name: 'Trip' });
    p.tracks[0].clips.push(makeClip('video', { assetId: 'v', duration: 2 * US }));
    p.assets.v = { id: 'v', kind: 'video', width: 100, height: 100, duration: 2 * US, hasAudio: true };
    const d = openExportDialog(ctxWith(p));
    await flush();
    const format = [...d.el.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'mov'));
    const exportBtn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    const note = d.el.querySelector('.export-codec-note');
    expect(exportBtn.disabled).toBe(false);
    format.value = 'mov';
    format.dispatchEvent(new Event('change'));
    expect(note.textContent).toMatch(/cannot encode sound for MOV/);
    expect(exportBtn.disabled).toBe(true);
    // Without sound, MOV is fine.
    d.el.querySelector('button.switch').click();
    expect(note.textContent).not.toMatch(/cannot encode sound/);
    expect(exportBtn.disabled).toBe(false);
    d.close();
  });

  it("starts at the timeline's frame rate, keeping a rate picked for it this session", async () => {
    const { setPref } = await import('../src/ui/prefs.js');
    setPref('exportSettings', { fps: 30, resolution: 720 });
    const make = (fps) => {
      const p = createProject({ name: 'Trip' });
      p.settings.fps = fps;
      p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: 2 * US }));
      p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
      return p;
    };
    const fpsSelect = (d) => [...d.el.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.textContent === '25 fps'));
    const resSelect = (d) => [...d.el.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.textContent === '720p'));
    const pal = make(25);
    let d = openExportDialog(ctxWith(pal));
    await flush();
    let sel = fpsSelect(d);
    expect(sel.value).toBe('25');
    sel.value = '50';
    sel.dispatchEvent(new Event('change'));
    d.close();
    d = openExportDialog(ctxWith(pal));
    await flush();
    expect(fpsSelect(d).value).toBe('50');
    d.close();
    d = openExportDialog(ctxWith(make(24)));
    await flush();
    expect(fpsSelect(d).value).toBe('24');
    // Other choices are still remembered.
    expect(resSelect(d).value).toBe('720');
    d.close();
    setPref('exportSettings', null);
  });

  it('labels every control and lists only encodable codecs', async () => {
    const p = createProject({ name: 'Trip' });
    p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: 2 * US }));
    p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
    const d = openExportDialog(ctxWith(p));
    await flush();
    const el = d.el;
    for (const c of el.querySelectorAll('input, select, button')) {
      const labelled = c.getAttribute('aria-label') || c.getAttribute('aria-labelledby') || (c.id && el.querySelector(`label[for="${c.id}"]`)) || c.textContent.trim();
      expect(labelled, c.outerHTML).toBeTruthy();
    }
    const selects = [...el.querySelectorAll('select')];
    const codec = selects.find((s) => [...s.options].some((o) => o.value === 'avc'));
    expect([...codec.options].map((o) => o.value)).toEqual(['avc', 'vp9']);
    expect(el.querySelector('input[type=text]').value).toBe('Trip');
    expect(el.textContent).toMatch(/Length 00:02/);
    // Picking VP9 moves the format to WebM.
    codec.value = 'vp9';
    codec.dispatchEvent(new Event('change'));
    const format = selects.find((s) => [...s.options].some((o) => o.value === 'webm'));
    expect(format.value).toBe('webm');
    d.close();
  });

  it('disables Export for an empty timeline and when nothing is checked', async () => {
    const d = openExportDialog(ctxWith(createProject()));
    await flush();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    expect(btn.disabled).toBe(true);
    d.close();
    const p = createProject();
    p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: US }));
    p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
    const d2 = openExportDialog(ctxWith(p));
    await flush();
    const btn2 = [...d2.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    expect(btn2.disabled).toBe(false);
    d2.el.querySelector('.export-check').click(); // uncheck Video, Audio is off too
    expect(btn2.disabled).toBe(true);
    d2.close();
  });

  it('picks which timeline to export when the project has several', async () => {
    const { ensureTimelines, addTimeline } = await import('../src/model/timelines.js');
    const p = createProject({ name: 'Trip' });
    p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: 2 * US }));
    p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
    ensureTimelines(p);
    const short = addTimeline(p, { name: 'Short' });
    const opened = [];
    const ctx = ctxWith(p);
    ctx.timelines = {
      list: () => p.timelines.map((t) => ({ id: t.id, name: t.name, active: t.id === p.timelineId })),
      active: () => ({ id: p.timelineId, name: 'Timeline 1' }),
      open: (id) => opened.push(id),
    };
    ctx.openExport = vi.fn();
    const d = openExportDialog(ctx);
    await flush();
    expect(d.el.querySelector('input[type=text]').value).toBe('Trip - Timeline 1');
    const sel = [...d.el.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.textContent === 'Short'));
    expect(sel.closest('.export-row').hidden).toBe(false);
    sel.value = short;
    sel.dispatchEvent(new Event('change'));
    expect(opened).toEqual([short]);
    expect(ctx.openExport).toHaveBeenCalled();
    expect(d.el.isConnected).toBe(false);
  });
});

describe('export dialog with several files', () => {
  const twoJobs = async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
    const p = createProject({ name: 'Trip' });
    p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: 2 * US }));
    p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
    const d = openExportDialog(ctxWith(p));
    await flush();
    const section = (title) => [...d.el.querySelectorAll('.export-section')].find((x) => x.querySelector('.export-section-title').textContent === title);
    const audio = section('Audio file').querySelector('.export-check');
    if (!audio.checked) audio.click();
    return d;
  };
  const released = [];
  const video = { kind: 'video', blob: new Blob(['mp4']), fileName: 'Trip.mp4', width: 1920, height: 1080, duration: 2 * US, elapsed: 1, release: () => released.push('video') };
  const button = (d, text) => [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

  it('keeps the finished video when the next file is canceled', async () => {
    exportProject.mockImplementation(async (project, library, settings, { kind, signal }) => {
      if (kind === 'video') return video;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Export canceled', 'AbortError'))));
      return null;
    });
    try {
      const d = await twoJobs();
      button(d, 'Export').click();
      await flush();
      await flush();
      button(d, 'Cancel').click();
      await flush();
      expect(d.el.querySelector('.dialog-title').textContent).toBe('Export canceled');
      expect([...d.el.querySelectorAll('.export-file-name')].map((x) => x.textContent)).toEqual(['Trip.mp4']);
      expect(d.el.textContent).toContain('The audio file was canceled.');
      expect(button(d, 'Download')).toBeTruthy();
      d.close();
    } finally {
      exportProject.mockReset();
      vi.restoreAllMocks();
    }
  });

  it('keeps the finished video when the next file fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exportProject.mockImplementation(async (project, library, settings, { kind }) => {
      if (kind === 'video') return video;
      throw new Error('boom');
    });
    try {
      const d = await twoJobs();
      button(d, 'Export').click();
      await flush();
      await flush();
      expect(d.el.querySelector('.dialog-title').textContent).toBe('Export failed');
      expect([...d.el.querySelectorAll('.export-file-name')].map((x) => x.textContent)).toEqual(['Trip.mp4']);
      expect(d.el.querySelector('[role=alert]').textContent).toMatch(/audio file could not be exported.*boom/);
      d.close();
    } finally {
      exportProject.mockReset();
      vi.restoreAllMocks();
    }
  });
});
