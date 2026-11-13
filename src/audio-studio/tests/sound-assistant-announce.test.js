// Sound Assistant: what Auto-Match announces to screen readers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { fakeApp } from './fx-helpers.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';

let measured = null;
vi.mock('../src/sound-assistant/ops.js', async (orig) => ({
  ...(await orig()),
  measureFile: async () => measured,
}));

const { soundAssistantPanel } = await import('../src/sound-assistant/panel.js');

const RATE = 48000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => document.body.replaceChildren());

async function autoMatch(lufs) {
  measured = lufs;
  const live = document.createElement('div');
  live.id = 'live-region';
  document.body.append(live);
  const doc = new AudioFile({
    name: 'a.wav',
    sampleRate: RATE,
    channels: [Channel.fromSamples(new Float32Array(RATE))],
  });
  const app = fakeApp();
  app.documents = [doc];
  app.active = doc;
  const panel = soundAssistantPanel(app);
  document.body.append(panel.el);
  panel.el.querySelector('.sa-type-btn[data-type="dialogue"]').click();
  await wait(20);
  panel.el.querySelector('.sa-loudness .sa-action').click();
  await wait(80);
  return live.textContent;
}

describe('Sound Assistant Auto-Match announcement', () => {
  it('announces a measurement', async () => {
    expect(await autoMatch(-30)).toBe('Loudness measured');
  });

  it('announces that audio too quiet to measure was not measured', async () => {
    expect(await autoMatch(null)).toBe('The audio is too quiet or too short to measure');
  });
});
