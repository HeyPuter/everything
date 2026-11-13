// Session files (.asesx): an original JSON format holding the session state
// and references to its media. Media files live next to the session in a
// "<SessionName>_Media" folder as WAV files. Remix settings and plans travel
// in the clips (clip.remix); the music analysis behind them is made again
// after opening.
//
// {
//   "format": "audio-studio-session", "version": 1,
//   "name": "Song.asesx",
//   "session": <state without sample data>,
//   "sources": [{ "id", "name", "file": "Song_Media/Take 1.wav", "sampleRate", "channels", "frames" }],
//   "video": { "id", "name", "file" (in the media folder) or "path" (on Puter), "mime", "width", "height", "duration", "fps" },
//   "view": { "start", "end" }
// }
//
// "video" is present when the session has a video clip (session.video); see session-video.js.

import { createTrack, createClip } from './session-edits.js';
import { cleanPresets } from '../multitrack/visibility.js';
import { serializeVideo, parseVideoClip } from './session-video.js';
import { createMarker } from './markers.js';

export const SESSION_FORMAT = 'audio-studio-session';
export const SESSION_VERSION = 1;
export const SESSION_EXT = 'asesx';

/** File-system safe name for a media file. */
export function safeFileName(name) {
  const cleaned = String(name || 'Audio')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .trim()
    .slice(0, 80);
  return cleaned || 'Audio';
}

export function sessionBaseName(name) {
  return String(name || 'Untitled Session').replace(/\.asesx$/i, '');
}

export function mediaFolderName(sessionName) {
  return `${safeFileName(sessionBaseName(sessionName))}_Media`;
}

/**
 * Serializes a session. Returns { text, media, video } where media lists
 * { id, file, channels, sampleRate } for every source used by the session and
 * video is the video file to write ({ id, file, blob }) or null. `embedVideo`
 * stores the video in the media folder even when it is referenced on Puter.
 */
export function serializeSession(session, { name = session.name, embedVideo = false } = {}) {
  const state = session.state;
  // A clip stretched by Sound Assistant Duration keeps its original audio for undoing the stretch.
  // A time-stretched clip keeps its original audio for restretching, a remixed clip for remixing again.
  const used = new Set(state.clips.flatMap((c) => [c.sourceId, c.soundAssistant?.duration?.orig?.sourceId, c.stretch?.sourceId, c.remix?.sourceId].filter(Boolean)));
  const folder = mediaFolderName(name);
  const taken = new Set();
  const media = [];
  const sources = [];
  for (const [id, src] of session.pool) {
    if (!used.has(id)) continue;
    let base = safeFileName(src.name);
    let file = `${base}.wav`;
    for (let i = 2; taken.has(file.toLowerCase()); i++) file = `${base} ${i}.wav`;
    taken.add(file.toLowerCase());
    const path = `${folder}/${file}`;
    const frames = src.channels?.[0]?.length ?? src.frames ?? 0;
    sources.push({ id, name: src.name, file: path, sampleRate: session.sampleRate, channels: src.channels?.length ?? src.channelCount ?? 2, frames });
    media.push({ id, file: path, channels: src.channels, sampleRate: session.sampleRate });
  }
  const video = serializeVideo(session, { folder, embed: embedVideo, taken });
  const doc = {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    name,
    session: state,
    sources,
    ...(video ? { video: video.entry } : {}),
    view: { start: Math.round(session.view.start), end: Math.round(session.view.end) },
  };
  return { text: JSON.stringify(doc, null, 1), media, video: video?.media || null };
}

/** Parses session text into { name, state, sources, video, view }; throws a readable error when invalid. */
export function parseSession(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('This session file is damaged or is not an Audio Studio session.');
  }
  if (!doc || doc.format !== SESSION_FORMAT || !doc.session) throw new Error('This file is not an Audio Studio session.');
  if (doc.version > SESSION_VERSION) throw new Error('This session was saved by a newer version of Audio Studio.');
  const s = doc.session;
  const tracks = (s.tracks || []).map((t) => createTrack(t));
  const trackIds = new Set(tracks.map((t) => t.id));
  for (const t of tracks) if (t.output !== 'master' && !trackIds.has(t.output)) t.output = 'master';
  const sourceIds = new Set((doc.sources || []).map((x) => x.id));
  // A stretched clip whose original audio is missing keeps playing its stretched audio, without restretching;
  // a remixed clip likewise keeps its remixed audio. A remixed clip without its remixed audio is made
  // again from its original and plan (multitrack/remix.js) when the original is there.
  const remade = (c) => c.remix?.segments?.length && sourceIds.has(c.remix.sourceId);
  const clips = (s.clips || [])
    .filter((c) => trackIds.has(c.trackId) && (sourceIds.has(c.sourceId) || remade(c)))
    .map((c) => {
      let clip = c;
      if (clip.stretch && !sourceIds.has(clip.stretch.sourceId)) clip = { ...clip, stretch: null };
      if (clip.remix && !sourceIds.has(clip.remix.sourceId)) clip = { ...clip, remix: null };
      return createClip(clip);
    });
  const state = {
    sampleRate: Number(s.sampleRate) || 48000,
    bitDepth: Number(s.bitDepth) || 32,
    tempo: Number(s.tempo) || 120,
    beatsPerBar: Number(s.beatsPerBar) || 4,
    metronome: Boolean(s.metronome),
    ...(typeof s.metronomeSound === 'string' ? { metronomeSound: s.metronomeSound } : {}),
    autoCrossfade: s.autoCrossfade !== false,
    tracks,
    master: createTrack({ ...(s.master || {}), type: 'master' }),
    clips,
    // Marker ids only hold within a page: saved ones could match ids new markers get here.
    markers: (s.markers || []).map((m) => createMarker({ name: m.name, start: m.start || 0, duration: m.duration || 0, type: m.type || 'cue', description: m.description || '' })),
  };
  // Track visibility presets (Multitrack > Track Visibility), when the session has any.
  if (s.visibilityPresets) state.visibilityPresets = cleanPresets(s.visibilityPresets, trackIds);
  const video = parseVideoClip(s.video, doc.video);
  if (video) state.video = video;
  return { name: doc.name, state, sources: doc.sources || [], video: video ? doc.video : null, view: doc.view || null };
}
