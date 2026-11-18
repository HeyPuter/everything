import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import * as V from '../src/model/session-video.js';
import { insertDocs, INSERT_HOOKS } from '../src/multitrack/insert.js';
import { insertVideoHook, linkVideo, setVideoOfDoc } from '../src/video/media.js';

const hooks = INSERT_HOOKS.slice();
beforeEach(() => { INSERT_HOOKS.splice(0, INSERT_HOOKS.length, insertVideoHook); });
afterEach(() => { INSERT_HOOKS.splice(0, INSERT_HOOKS.length, ...hooks); document.body.replaceChildren(); });

function setup() {
  const session = new Session({ name: 'Session', sampleRate: 48000, tracks: 1 });
  const file = (name) => new AudioFile({ name, sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(480).fill(0.5))] });
  return { session, file, app: { documents: [session] }, track: session.state.tracks[0].id };
}

it('preserves an edit made while preparing inserted audio and keeps separate undo steps', async () => {
  const { session, file, app, track } = setup();
  const inserting = insertDocs(app, session, [file('Take.wav')]);
  session.apply('Track volume', S.updateTrack(session.state, track, { volume: -6 }));
  await inserting;
  expect(S.findTrack(session.state, track).volume).toBe(-6);
  expect(session.state.clips).toHaveLength(1);
  session.history.undo();
  expect(S.findTrack(session.state, track).volume).toBe(-6);
  expect(session.state.clips).toHaveLength(0);
});

it('does not restore a track deleted while preparing an insertion', async () => {
  const { session, file, app, track } = setup();
  const inserting = insertDocs(app, session, [file('Take.wav')], { trackId: track });
  session.apply('Delete track', S.removeTracks(session.state, [track]));
  const [id] = await inserting;
  expect(S.findTrack(session.state, track)).toBeFalsy();
  const clip = S.findClip(session.state, id);
  expect(S.findTrack(session.state, clip.trackId)).toBeTruthy();
});

it('keeps both clips when two insertions overlap in time', async () => {
  const { session, file, app } = setup();
  const [first, second] = await Promise.all([
    insertDocs(app, session, [file('First.wav')], { at: 0 }),
    insertDocs(app, session, [file('Second.wav')], { at: 480 }),
  ]);
  expect(session.state.clips.map((c) => c.id).sort()).toEqual([...first, ...second].sort());
  session.history.undo();
  expect(session.state.clips.map((c) => c.id)).toEqual(first);
});

it('preserves edits made while confirming a video replacement', async () => {
  const { session, file, app, track } = setup();
  const info = (name) => ({ name, blob: new Blob([name]), width: 320, height: 180, duration: 0.01, fps: 25 });
  session.apply('Video', V.setVideoClip(session.state, { sourceId: linkVideo(session, info('Old.mp4')), name: 'Old', start: 0, length: 480 }));
  const audio = file('New.mp4');
  setVideoOfDoc(audio, info('New.mp4'));
  const inserting = insertDocs(app, session, [audio]);
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
  session.apply('Track volume', S.updateTrack(session.state, track, { volume: -6 }));
  const replace = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Replace');
  replace.click();
  await inserting;
  expect(S.findTrack(session.state, track).volume).toBe(-6);
  expect(V.videoClip(session.state).name).toBe('New');
  session.history.undo();
  expect(S.findTrack(session.state, track).volume).toBe(-6);
  expect(V.videoClip(session.state).name).toBe('Old');
});
