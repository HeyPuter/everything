// Pure project edits. Each takes a project and returns a new one (or the same
// object when nothing changed), sharing untouched parts. No DOM, no engine:
// these run in tests as-is. Views call them through store.apply(label, fn).

import { uid, clamp, moveItem } from '../lib/util.js';
import { createChannel, createPattern, createTrack, createMixerTrack, createSlot, createClip, createNote, nextPatternName, MAX_FX_SLOTS, DEFAULT_KEY } from './project.js';
import { STEP } from './time.js';

// ------------------------------------------------------------------ helpers

function updateById(list, id, fn) {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return list;
  const next = fn(list[i]);
  if (next === list[i]) return list;
  const out = list.slice();
  out[i] = next;
  return out;
}

function updateAt(list, i, fn) {
  if (i < 0 || i >= list.length) return list;
  const next = fn(list[i]);
  if (next === list[i]) return list;
  const out = list.slice();
  out[i] = next;
  return out;
}

function patch(obj, changes) {
  for (const k of Object.keys(changes)) if (obj[k] !== changes[k]) return { ...obj, ...changes };
  return obj;
}

const sortNotes = (notes) => notes.slice().sort((a, b) => a.pos - b.pos || a.key - b.key);

// ------------------------------------------------------------------ project

export function setProjectProps(project, changes) {
  const c = { ...changes };
  if ('bpm' in c) c.bpm = clamp(Math.round(c.bpm * 1000) / 1000, 10, 522);
  if ('swing' in c) c.swing = clamp(c.swing, 0, 1);
  return patch(project, c);
}

// ------------------------------------------------------------------ channels

export function addChannel(project, channel = createChannel(), index = project.channels.length) {
  const channels = project.channels.slice();
  channels.splice(clamp(index, 0, channels.length), 0, channel);
  return { ...project, channels };
}

export function updateChannel(project, id, changes) {
  const channels = updateById(project.channels, id, (c) => patch(c, changes));
  return channels === project.channels ? project : { ...project, channels };
}

export function setChannelParam(project, id, param, value) {
  const channels = updateById(project.channels, id, (c) => (c.params[param] === value ? c : { ...c, params: { ...c.params, [param]: value } }));
  return channels === project.channels ? project : { ...project, channels };
}

/** Removes channels with their notes in every pattern and the audio clips that play them. */
export function removeChannels(project, ids) {
  const set = new Set(ids);
  if (!project.channels.some((c) => set.has(c.id))) return project;
  const patterns = project.patterns.map((p) => {
    if (!Object.keys(p.notes).some((k) => set.has(k))) return p;
    const notes = {};
    for (const [k, v] of Object.entries(p.notes)) if (!set.has(k)) notes[k] = v;
    return { ...p, notes };
  });
  return {
    ...project,
    channels: project.channels.filter((c) => !set.has(c.id)),
    patterns,
    clips: project.clips.filter((c) => !(c.kind === 'audio' && set.has(c.ref))),
  };
}

export function moveChannel(project, id, to) {
  const from = project.channels.findIndex((c) => c.id === id);
  if (from < 0 || from === to) return project;
  return { ...project, channels: moveItem(project.channels, from, clamp(to, 0, project.channels.length - 1)) };
}

/** Copies a channel (settings and, optionally, its notes in every pattern) right after it. */
export function cloneChannel(project, id, { withNotes = false } = {}) {
  const i = project.channels.findIndex((c) => c.id === id);
  if (i < 0) return { project, id: null };
  const src = project.channels[i];
  const copy = { ...structuredClone(src), id: uid(), name: `${src.name} #2`, solo: false };
  let next = addChannel(project, copy, i + 1);
  if (withNotes) {
    next = {
      ...next,
      patterns: next.patterns.map((p) => (p.notes[id] ? { ...p, notes: { ...p.notes, [copy.id]: p.notes[id].map((n) => ({ ...n, id: uid(6) })) } } : p)),
    };
  }
  return { project: next, id: copy.id };
}

/** Solo toggle the way the rack does it: solo this one alone, or clear solo when it already is. */
export function soloChannel(project, id) {
  const ch = project.channels.find((c) => c.id === id);
  if (!ch) return project;
  const alone = ch.solo && project.channels.every((c) => c.id === id || !c.solo);
  return { ...project, channels: project.channels.map((c) => patch(c, { solo: alone ? false : c.id === id, mute: alone ? c.mute : c.id === id ? false : c.mute })) };
}

// ------------------------------------------------------------------ patterns

export function addPattern(project, { after, name } = {}) {
  const pattern = createPattern(project.patterns.length, name || nextPatternName(project));
  const patterns = project.patterns.slice();
  const i = after ? patterns.findIndex((p) => p.id === after) + 1 : patterns.length;
  patterns.splice(i || patterns.length, 0, pattern);
  return { project: { ...project, patterns }, id: pattern.id };
}

export function updatePattern(project, id, changes) {
  const patterns = updateById(project.patterns, id, (p) => patch(p, changes));
  return patterns === project.patterns ? project : { ...project, patterns };
}

/** Deletes a pattern and its playlist clips. The last pattern is never removed. */
export function removePattern(project, id) {
  if (project.patterns.length <= 1 || !project.patterns.some((p) => p.id === id)) return project;
  return {
    ...project,
    patterns: project.patterns.filter((p) => p.id !== id),
    clips: project.clips.filter((c) => !(c.kind === 'pattern' && c.ref === id)),
  };
}

export function clonePattern(project, id) {
  const i = project.patterns.findIndex((p) => p.id === id);
  if (i < 0) return { project, id: null };
  const src = project.patterns[i];
  const notes = {};
  for (const [k, list] of Object.entries(src.notes)) notes[k] = list.map((n) => ({ ...n, id: uid(6) }));
  const copy = { ...src, id: uid(), name: `${src.name} #2`, notes };
  const patterns = project.patterns.slice();
  patterns.splice(i + 1, 0, copy);
  return { project: { ...project, patterns }, id: copy.id };
}

export function movePattern(project, id, to) {
  const from = project.patterns.findIndex((p) => p.id === id);
  if (from < 0 || from === to) return project;
  return { ...project, patterns: moveItem(project.patterns, from, clamp(to, 0, project.patterns.length - 1)) };
}

/** Replaces one channel's notes in a pattern (sorted by position, then key). */
export function setNotes(project, patternId, channelId, notes) {
  const patterns = updateById(project.patterns, patternId, (p) => {
    if (p.notes[channelId] === notes) return p;
    const out = { ...p.notes };
    if (notes.length) out[channelId] = sortNotes(notes);
    else delete out[channelId];
    return { ...p, notes: out };
  });
  return patterns === project.patterns ? project : { ...project, patterns };
}

export function getNotes(project, patternId, channelId) {
  return project.patterns.find((p) => p.id === patternId)?.notes[channelId] || [];
}

export function addNotes(project, patternId, channelId, notes) {
  return setNotes(project, patternId, channelId, [...getNotes(project, patternId, channelId), ...notes.map((n) => (n.id ? n : { ...n, id: uid(6) }))]);
}

export function removeNotes(project, patternId, channelId, ids) {
  const set = new Set(ids);
  const list = getNotes(project, patternId, channelId);
  const next = list.filter((n) => !set.has(n.id));
  return next.length === list.length ? project : setNotes(project, patternId, channelId, next);
}

/** Applies per-note changes: `changes` maps note id to a partial note. */
export function updateNotes(project, patternId, channelId, changes) {
  const list = getNotes(project, patternId, channelId);
  let touched = false;
  const next = list.map((n) => {
    const c = changes instanceof Map ? changes.get(n.id) : changes[n.id];
    if (!c) return n;
    const m = patch(n, c);
    if (m !== n) touched = true;
    return m;
  });
  return touched ? setNotes(project, patternId, channelId, next) : project;
}

/** Whether a step (sixteenth) has a note starting in it. */
export function stepOn(notes, step) {
  const a = step * STEP;
  return notes.some((n) => n.pos >= a && n.pos < a + STEP);
}

/** Turns a step on (a one-step note at the channel's root key) or off (removes notes starting in it). */
export function toggleStep(project, patternId, channelId, step, on) {
  const list = getNotes(project, patternId, channelId);
  const a = step * STEP;
  const has = list.some((n) => n.pos >= a && n.pos < a + STEP);
  const want = on ?? !has;
  if (want === has) return project;
  if (!want) return setNotes(project, patternId, channelId, list.filter((n) => !(n.pos >= a && n.pos < a + STEP)));
  const ch = project.channels.find((c) => c.id === channelId);
  return setNotes(project, patternId, channelId, [...list, createNote({ key: ch?.root ?? DEFAULT_KEY, pos: a, len: STEP })]);
}

// ------------------------------------------------------------------ playlist

export function updateTrack(project, index, changes) {
  const tracks = updateAt(project.tracks, index, (t) => patch(t, changes));
  return tracks === project.tracks ? project : { ...project, tracks };
}

/** Makes sure the playlist has at least `count` tracks. */
export function ensureTracks(project, count) {
  if (project.tracks.length >= count) return project;
  const tracks = project.tracks.slice();
  while (tracks.length < count) tracks.push(createTrack(tracks.length));
  return { ...project, tracks };
}

/** Moves a playlist track, carrying its clips along. */
export function moveTrack(project, from, to) {
  if (from === to || from < 0 || to < 0 || from >= project.tracks.length || to >= project.tracks.length) return project;
  const order = moveItem(project.tracks.map((_, i) => i), from, to);
  const newIndex = new Map(order.map((old, i) => [old, i]));
  return {
    ...project,
    tracks: order.map((i) => project.tracks[i]),
    clips: project.clips.map((c) => patch(c, { track: newIndex.get(c.track) ?? c.track })),
  };
}

export function addClips(project, clips) {
  const made = clips.map((c) => (c.id ? c : createClip(c)));
  const maxTrack = made.reduce((m, c) => Math.max(m, c.track), -1);
  const p = ensureTracks(project, maxTrack + 1);
  return { project: { ...p, clips: [...p.clips, ...made] }, ids: made.map((c) => c.id) };
}

export function removeClips(project, ids) {
  const set = new Set(ids);
  const clips = project.clips.filter((c) => !set.has(c.id));
  return clips.length === project.clips.length ? project : { ...project, clips };
}

/** Applies per-clip changes: `changes` maps clip id to a partial clip. */
export function updateClips(project, changes) {
  let touched = false;
  const get = (id) => (changes instanceof Map ? changes.get(id) : changes[id]);
  const clips = project.clips.map((c) => {
    const ch = get(c.id);
    if (!ch) return c;
    const m = patch(c, ch);
    if (m !== c) touched = true;
    return m;
  });
  if (!touched) return project;
  const maxTrack = clips.reduce((m, c) => Math.max(m, c.track), -1);
  return ensureTracks({ ...project, clips }, maxTrack + 1);
}

export function setLoop(project, loop) {
  if (loop && loop.end <= loop.start) loop = null;
  if (!loop && !project.loop) return project;
  if (loop && project.loop && loop.start === project.loop.start && loop.end === project.loop.end) return project;
  return { ...project, loop: loop ? { start: loop.start, end: loop.end } : null };
}

// ------------------------------------------------------------------ automation

export function addAutomation(project, automation) {
  const a = { id: uid(), name: 'Automation', points: [{ t: 0, v: 0.5 }], ...automation };
  return { project: { ...project, automation: { ...project.automation, [a.id]: a } }, id: a.id };
}

export function updateAutomation(project, id, changes) {
  const a = project.automation[id];
  if (!a) return project;
  const next = patch(a, changes);
  return next === a ? project : { ...project, automation: { ...project.automation, [id]: next } };
}

export function removeAutomation(project, id) {
  if (!project.automation[id]) return project;
  const automation = { ...project.automation };
  delete automation[id];
  return { ...project, automation, clips: project.clips.filter((c) => !(c.kind === 'auto' && c.ref === id)) };
}

// ------------------------------------------------------------------ mixer

export function updateMixerTrack(project, index, changes) {
  const mixer = updateAt(project.mixer, index, (t) => patch(t, changes));
  return mixer === project.mixer ? project : { ...project, mixer };
}

export function addMixerTrack(project) {
  return { project: { ...project, mixer: [...project.mixer, createMixerTrack(project.mixer.length)] }, index: project.mixer.length };
}

/** Sets a send from insert `from` to `to` (gain 0 or null removes it). Feedback loops are refused. */
export function setRoute(project, from, to, gain) {
  if (from === 0 || from === to || !project.mixer[from] || !project.mixer[to]) return project;
  if (gain && routesTo(project, to, from)) return project;
  return updateMixerTrack(project, from, {
    routes: (() => {
      const r = { ...project.mixer[from].routes };
      if (gain) r[to] = gain;
      else delete r[to];
      return r;
    })(),
  });
}

/** Whether insert `from` reaches insert `to` through its routes. */
export function routesTo(project, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const k of Object.keys(project.mixer[from]?.routes || {})) if (routesTo(project, Number(k), to, seen)) return true;
  return false;
}

export function addSlot(project, track, type, at) {
  const t = project.mixer[track];
  if (!t || t.fx.length >= MAX_FX_SLOTS) return { project, id: null };
  const slot = createSlot(type);
  const fx = t.fx.slice();
  fx.splice(at ?? fx.length, 0, slot);
  return { project: updateMixerTrack(project, track, { fx }), id: slot.id };
}

export function updateSlot(project, track, slotId, changes) {
  const t = project.mixer[track];
  if (!t) return project;
  const fx = updateById(t.fx, slotId, (s) => patch(s, changes));
  return fx === t.fx ? project : updateMixerTrack(project, track, { fx });
}

export function setSlotParam(project, track, slotId, param, value) {
  const t = project.mixer[track];
  if (!t) return project;
  const fx = updateById(t.fx, slotId, (s) => (s.params[param] === value ? s : { ...s, params: { ...s.params, [param]: value } }));
  return fx === t.fx ? project : updateMixerTrack(project, track, { fx });
}

export function removeSlot(project, track, slotId) {
  const t = project.mixer[track];
  if (!t || !t.fx.some((s) => s.id === slotId)) return project;
  return updateMixerTrack(project, track, { fx: t.fx.filter((s) => s.id !== slotId) });
}

export function moveSlot(project, track, slotId, to) {
  const t = project.mixer[track];
  const from = t?.fx.findIndex((s) => s.id === slotId) ?? -1;
  if (from < 0 || from === to) return project;
  return updateMixerTrack(project, track, { fx: moveItem(t.fx, from, clamp(to, 0, t.fx.length - 1)) });
}

// ------------------------------------------------------------------ samples

export function addSample(project, ref) {
  const s = { id: ref.id || uid(), name: 'Sample', path: null, local: null, duration: 0, rate: 44100, channels: 2, ...ref };
  return { project: { ...project, samples: { ...project.samples, [s.id]: s } }, id: s.id };
}

export function updateSample(project, id, changes) {
  const s = project.samples[id];
  if (!s) return project;
  const next = patch(s, changes);
  return next === s ? project : { ...project, samples: { ...project.samples, [id]: next } };
}
