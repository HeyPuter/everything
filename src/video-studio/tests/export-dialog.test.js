import { describe, it, expect, beforeEach, vi } from 'vitest';
import { US } from '../src/lib/time.js';
import { createProject, makeClip } from '../src/model/project.js';

vi.mock('../src/engine/exporter.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    detectCapabilities: vi.fn(async () => ({ video: ['avc', 'vp9'], audio: ['aac', 'opus'], audioFormats: ['wav', 'm4a', 'ogg'] })),
    renderStill: vi.fn(async () => null),
  };
});

const { openExportDialog } = await import('../src/ui/export-dialog.js');

function ctxWith(project) {
  return { store: { project, time: 0 }, library: { backend: { kind: 'opfs' } }, account: { user: null } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('export dialog', () => {
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
