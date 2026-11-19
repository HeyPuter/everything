import { afterEach, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import { insertDocs, placementOptions, embeddedStart } from '../src/multitrack/insert.js';

afterEach(() => (placementOptions.embeddedTimecode = false));

const file = (name, rate, timeRef) => new AudioFile({ name, sampleRate: rate, channels: [Channel.fromSamples(new Float32Array(100).fill(0.1))], meta: timeRef ? { bextTimeRef: String(timeRef) } : {} });

function setup() {
  localStorage.clear();
  const app = new App();
  app.syncGraph = () => {};
  const doc = app.addDocument(new Session({ name: 'T.asesx', sampleRate: 1000, tracks: 2 }));
  doc.selectTrack(doc.state.tracks[0].id);
  return { app, doc };
}

it('converts a time reference to the timeline rate', () => {
  expect(embeddedStart(file('a.wav', 2000, 4000), 1000)).toBe(2000);
  expect(embeddedStart(file('b.wav', 1000), 1000)).toBe(null);
});

it('places files at their embedded timecode only when the preference is on', async () => {
  const { app, doc } = setup();
  const [a] = await insertDocs(app, doc, [file('a.wav', 1000, 5000)], { at: 10 });
  expect(S.findClip(doc.state, a).start).toBe(10);
  placementOptions.embeddedTimecode = true;
  const [b, c] = await insertDocs(app, doc, [file('b.wav', 1000, 5000), file('c.wav', 1000)], { at: 10 });
  expect(S.findClip(doc.state, b).start).toBe(5000);
  // A file without one still goes to the playhead.
  expect(S.findClip(doc.state, c).start).toBe(10);
});
