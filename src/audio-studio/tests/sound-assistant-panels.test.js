// DOM behaviour of the Sound Assistant, Diagnostics and Batch Process panels.
import { describe, it, expect, beforeAll } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { fakeApp } from './fx-helpers.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Session } from '../src/model/session.js';
import { createClip, addClips, findClip } from '../src/model/session-edits.js';
import { soundAssistantPanel } from '../src/sound-assistant/panel.js';
import { getFileSettings } from '../src/sound-assistant/ops.js';
import { diagnosticsPanel } from '../src/diagnostics/panel.js';
import { setDiagnosticsWorker } from '../src/diagnostics/scan.js';
import { batchPanel } from '../src/batch/panel.js';

const RATE = 48000;
const tick = () => new Promise((r) => setTimeout(r, 0));

function appWith(doc) {
  const app = fakeApp();
  app.formatTime = (f, rate = RATE) => (f / rate).toFixed(3);
  app.documents = doc ? [doc] : [];
  app.active = doc;
  doc?.on('change', (e) => app.emit('doc-change', doc, e));
  return app;
}

function session() {
  const s = new Session({ name: 'P.asesx', sampleRate: RATE, tracks: 2 });
  const src = s.addSource({ name: 'a', channels: [Channel.fromSamples(new Float32Array(RATE))] });
  const a = createClip({ trackId: s.state.tracks[0].id, sourceId: src, start: 0, length: RATE });
  const b = createClip({ trackId: s.state.tracks[1].id, sourceId: src, start: RATE, length: RATE });
  s.apply('Add', addClips(s.state, [a, b]));
  return { s, a: a.id, b: b.id };
}

beforeAll(() => setDiagnosticsWorker(null));

describe('Sound Assistant panel', () => {
  it('asks for a clip selection, then assigns a type to the selected clips', () => {
    const { s, a, b } = session();
    const app = appWith(s);
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    expect(panel.el.textContent).toMatch(/Select one or more clips/);
    s.selectClips([a, b]);
    const buttons = [...panel.el.querySelectorAll('.sa-type-btn')];
    expect(buttons.map((x) => x.textContent)).toEqual(['Dialogue', 'Music', 'SFX', 'Ambience']);
    buttons[2].click();
    expect(findClip(s.state, a).soundAssistant.type).toBe('sfx');
    expect(findClip(s.state, b).soundAssistant.type).toBe('sfx');
    expect(panel.el.querySelector('.sa-type-name').textContent).toBe('SFX');
    expect(panel.el.querySelector('.sa-count').textContent).toBe('2 clips');
    panel.el.remove();
  });

  it('turns tasks on, coalesces slider drags into one undo step and clears', () => {
    const { s, a } = session();
    const app = appWith(s);
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    s.selectClips([a]);
    panel.el.querySelector('.sa-type-btn[data-type="dialogue"]').click();
    const repair = panel.el.querySelector('.sa-repair .sa-section-toggle input');
    repair.click();
    expect(findClip(s.state, a).fx.map((x) => x.effect)).toEqual(['parametricEq', 'denoise']);
    const steps = s.history.entries.length;
    const slider = panel.el.querySelector('.sa-repair .sa-slider');
    for (const v of [5, 6, 7]) {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
    }
    slider.dispatchEvent(new Event('change'));
    expect(s.history.entries.length).toBe(steps + 1);
    expect(findClip(s.state, a).soundAssistant.repair.items.noise.amount).toBe(7);
    expect(panel.el.querySelector('.sa-repair output').textContent).toBe('7.0');
    // Presets replace the settings.
    const sel = panel.el.querySelector('.sa-preset select');
    sel.value = 'Phone Call';
    sel.dispatchEvent(new Event('change'));
    expect(findClip(s.state, a).soundAssistant.preset).toBe('Phone Call');
    expect(findClip(s.state, a).fx.map((x) => x.effect)).toEqual(['dynamics', 'parametricEq']);
    // Undo returns to the slider value.
    s.history.undo();
    expect(findClip(s.state, a).soundAssistant.repair.items.noise.amount).toBe(7);
    panel.el.querySelector('.sa-clear').click();
    expect(findClip(s.state, a).soundAssistant).toBe(null);
    expect(findClip(s.state, a).fx).toEqual([]);
    expect(panel.el.querySelector('.sa-type-btn')).not.toBe(null);
    panel.el.remove();
  });

  it('keeps file settings, previews them and offers Apply in the Waveform editor', () => {
    const doc = new AudioFile({ name: 'v.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE))] });
    const app = appWith(doc);
    let synced = 0;
    app.syncGraph = () => synced++;
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    panel.el.querySelector('.sa-type-btn[data-type="ambience"]').click();
    expect(getFileSettings(doc).type).toBe('ambience');
    const apply = panel.el.querySelector('.sa-apply');
    expect(apply.disabled).toBe(true);
    panel.el.querySelector('.sa-creative .sa-section-toggle input').click();
    expect(apply.disabled).toBe(false);
    expect(panel.el.querySelector('.sa-ducking').textContent).toMatch(/multitrack session/);
    panel.el.querySelector('.sa-preview').click();
    expect(app.previewFx.map((x) => x.key)).toEqual(['assistant:reverb']);
    expect(panel.el.querySelector('.sa-preview').getAttribute('aria-pressed')).toBe('true');
    panel.el.querySelector('.sa-preview').click();
    expect(app.previewFx).toBe(null);
    expect(synced).toBeGreaterThanOrEqual(2);
    panel.el.remove();
  });

  it('keeps keyboard focus in the panel after Apply rebuilds it', async () => {
    const tone = Channel.fromSamples(new Float32Array(RATE).fill(0.1));
    const doc = new AudioFile({ name: 'v.wav', sampleRate: RATE, channels: [tone] });
    const app = appWith(doc);
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    try {
      panel.el.querySelector('.sa-type-btn[data-type="dialogue"]').click();
      // Assigning a type focuses the panel's first control on the next frame.
      await new Promise((r) => requestAnimationFrame(r));
      const level = panel.el.querySelector('.sa-volume input[type="range"]');
      level.value = '3';
      level.dispatchEvent(new Event('input'));
      const apply = panel.el.querySelector('.sa-apply');
      apply.focus();
      apply.click();
      await expect.poll(() => doc.history.index).toBe(1);
      await tick();
      // Apply turned the tasks off and rebuilt the panel: focus stays in it, not on the page.
      expect(panel.el.querySelector('.sa-apply').disabled).toBe(true);
      expect(document.activeElement).toBe(panel.el.querySelector('.sa-preview'));
    } finally {
      panel.el.remove();
    }
  });
});

describe('Diagnostics panel', () => {
  it('scans, selects a row in the editor and repairs as one undo step', async () => {
    const n = RATE;
    const x = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE) + 0.1 * Math.sin((2 * Math.PI * 1210 * i) / RATE));
    for (const at of [8000, 30000]) {
      x[at] += 0.6;
      x[at + 1] -= 0.4;
    }
    const doc = new AudioFile({ name: 'c.wav', sampleRate: RATE, channels: [Channel.fromSamples(x)] });
    const app = appWith(doc);
    const panel = diagnosticsPanel(app);
    document.body.append(panel.el);
    expect(panel.el.querySelector('.diag-effect').value).toBe('declicker');
    const scanFile = [...panel.el.querySelectorAll('.diag-toolbar .btn')].find((b) => b.textContent === 'Scan File');
    scanFile.click();
    for (let i = 0; i < 200 && !/found/.test(panel.el.querySelector('.diag-caption').textContent); i++) await tick();
    expect(panel.el.querySelector('.diag-caption').textContent).toBe('2 clicks found.');
    const rows = panel.el.querySelectorAll('.diag-table tbody tr');
    expect(rows).toHaveLength(2);
    rows[1].click();
    expect(doc.selection.start).toBeLessThanOrEqual(30000);
    expect(doc.selection.end).toBeGreaterThan(30000);
    expect(panel.el.querySelector('.diag-count').textContent).toBe('1 of 2 clicks');
    const [repairSel, repairAll] = panel.el.querySelectorAll('.diag-actions .btn');
    expect(repairSel.textContent).toBe('Repair Selected');
    repairAll.click();
    for (let i = 0; i < 200 && doc.history.entries.length < 2; i++) await tick();
    expect(doc.history.entries.map((e) => e.label)).toEqual(['Open', 'DeClicker: Repair 2 clicks']);
    expect(panel.el.querySelectorAll('.diag-table tbody tr td.empty-row')).toHaveLength(1);
    // Undo makes the list stale.
    doc.history.undo();
    expect(panel.el.querySelector('.diag-caption').textContent).toMatch(/Scan again/);
    panel.el.remove();
  });

  it('switches diagnostics and their action names', () => {
    const doc = new AudioFile({ name: 's.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE))] });
    const app = appWith(doc);
    const panel = diagnosticsPanel(app);
    const sel = panel.el.querySelector('.diag-effect');
    sel.value = 'markAudio';
    sel.dispatchEvent(new Event('change'));
    expect([...panel.el.querySelectorAll('.diag-actions .btn')].filter((b) => !b.hidden).map((b) => b.textContent)).toEqual(['Mark Selected', 'Mark All']);
    expect(app.prefs.get('diagnostics').effect).toBe('markAudio');
    expect(panel.el.querySelector('.diag-settings').textContent).toMatch(/Marker Padding/);
  });
});

describe('Batch Process panel', () => {
  it('lists open files, selects with the keyboard and removes them', () => {
    const docs = ['a.wav', 'b.wav', 'c.wav'].map((name) => new AudioFile({ name, sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(10))] }));
    const app = appWith(null);
    app.documents = docs;
    const panel = batchPanel(app);
    document.body.append(panel.el);
    expect(panel.el.querySelector('.batch-run').disabled).toBe(true);
    panel.el.querySelector('.batch-toolbar .btn').click();
    let rows = panel.el.querySelectorAll('tbody tr');
    const nameAndStatus = (r) => r.querySelector('.batch-name').textContent + r.querySelector('.batch-status').textContent;
    expect([...rows].map(nameAndStatus)).toEqual(['a.wavReady', 'b.wavReady', 'c.wavReady']);
    expect(rows[0].querySelector('.batch-type').textContent).toMatch(new RegExp(`^${RATE} Hz, .*Mono$`));
    expect(rows[0].querySelector('.batch-out').textContent).toMatch(/^a\.\w+$/);
    expect(panel.el.querySelector('.batch-summary').textContent).toBe('3 files ready');
    rows[0].click();
    rows = panel.el.querySelectorAll('tbody tr');
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    rows = panel.el.querySelectorAll('tbody tr');
    expect([...rows].map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'true', 'false']);
    rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect([...panel.el.querySelectorAll('tbody tr')].map(nameAndStatus)).toEqual(['c.wavReady']);
    // Adding again skips files already listed.
    panel.el.querySelector('.batch-toolbar .btn').click();
    expect(panel.el.querySelectorAll('tbody tr')).toHaveLength(3);
    panel.el.querySelector('.batch-toolbar .btn').click();
    expect(app.notes.at(-1).m).toMatch(/already in the list/);
    // Favorites the batch cannot run are flagged.
    app.prefs.set('favorites', [{ id: 'x', name: 'Cut', action: { type: 'command', command: 'edit.cut' } }]);
    const fav = panel.el.querySelector('.batch-fav');
    fav.value = 'x';
    fav.dispatchEvent(new Event('change'));
    expect(panel.el.querySelector('.batch-note').textContent).toMatch(/cannot run/);
    panel.el.remove();
  });
});

describe('Sound Assistant layout', () => {
  it('wraps its header in narrow panels instead of pushing Clear Audio Type past the edge', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/sound-assistant.css`, 'utf8');
    // Measured in Chromium at 820 x 1180: the button ended past the panel's right edge.
    expect(css).toMatch(/\.sa-head \{[^}]*flex-wrap: wrap;/);
  });
});
