// Sound Assistant: picking a preset before an audio type is assigned assigns
// the preset's type with its settings; the panel names what it edits.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { fakeApp } from './fx-helpers.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Session } from '../src/model/session.js';
import { createClip, addClips, findClip, updateClips } from '../src/model/session-edits.js';
import { soundAssistantPanel } from '../src/sound-assistant/panel.js';
import { getFileSettings } from '../src/sound-assistant/ops.js';

const RATE = 48000;

function appWith(doc) {
  const app = fakeApp();
  app.formatTime = (f, rate = RATE) => (f / rate).toFixed(3);
  app.documents = [doc];
  app.active = doc;
  doc.on('change', (e) => app.emit('doc-change', doc, e));
  return app;
}

const pick = (panel, label) => {
  const sel = panel.el.querySelector('.sa-assign-preset select');
  const opt = [...sel.options].find((o) => o.textContent === label);
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change'));
};

describe('Sound Assistant preset before a type', () => {
  it('assigns the type and settings of the chosen preset to a file', () => {
    const doc = new AudioFile({ name: 'voice.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(RATE))] });
    const app = appWith(doc);
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    expect(panel.el.querySelector('.sa-target-name').textContent).toBe('voice.wav');
    const groups = [...panel.el.querySelectorAll('.sa-assign-preset optgroup')].map((g) => g.label);
    expect(groups).toEqual(['Dialogue', 'Music', 'SFX', 'Ambience']);
    pick(panel, 'Podcast Host');
    const s = getFileSettings(doc);
    expect(s.type).toBe('dialogue');
    expect(s.preset).toBe('Podcast Host');
    expect(s.loudness).toMatchObject({ on: true, target: -16 });
    expect(panel.el.querySelector('.sa-type-name').textContent).toBe('Dialogue');
    expect(panel.el.querySelector('.sa-preset select').value).toBe('Podcast Host');
    expect(panel.el.querySelector('.sa-editor .sa-target-name').textContent).toBe('voice.wav');
    panel.el.remove();
  });

  it('assigns a preset to selected clips in one undo step and keeps their volume', () => {
    const s = new Session({ name: 'P.asesx', sampleRate: RATE, tracks: 1 });
    const src = s.addSource({ name: 'a', channels: [Channel.fromSamples(new Float32Array(RATE))] });
    const a = createClip({ trackId: s.state.tracks[0].id, sourceId: src, start: 0, length: RATE, name: 'Bed' });
    s.apply('Add', addClips(s.state, [a]));
    s.apply('Gain', updateClips(s.state, [a.id], { gain: -4 }));
    const app = appWith(s);
    const panel = soundAssistantPanel(app);
    document.body.append(panel.el);
    s.selectClips([a.id]);
    expect(panel.el.querySelector('.sa-target-name').textContent).toBe('Bed');
    const undoDepth = s.history.index;
    pick(panel, 'Gentle Ducking');
    const clip = findClip(s.state, a.id);
    expect(clip.soundAssistant.type).toBe('music');
    expect(clip.soundAssistant.preset).toBe('Gentle Ducking');
    expect(clip.soundAssistant.ducking.on).toBe(true);
    expect(clip.gain).toBe(-4);
    expect(s.history.index).toBe(undoDepth + 1);
    panel.el.remove();
  });
});
