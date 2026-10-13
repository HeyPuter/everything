/**
 * Timelines: a project can hold several timelines (a long cut and its
 * shorts, versions, a vertical edit) that share its media. The open
 * timeline lives at the top level of the project (tracks, markers, range,
 * settings...) so the rest of the editor works on it unchanged; the others
 * wait in project.timelines with their contents.
 *
 * project.timelineId = id of the open timeline (absent while there is one)
 * project.timelines = [{ id, name, ...contents }]   // in display order; the
 *   open one keeps only { id, name }, its contents are at the top level
 * contents = { settings, tracks, markers, range?, transcript?, guides?, cover? }
 */
import { uid } from '../lib/ids.js';
import { makeTrack, makeClip } from './project.js';
import { sequenceLength, addClip } from './timeline.js';

/** Fields a timeline owns; everything else (media, bins, fonts, name) is shared. */
export const TIMELINE_FIELDS = ['settings', 'tracks', 'markers', 'range', 'transcript', 'guides', 'cover'];

export const MAX_TIMELINES = 50;

const DEFAULT_NAME = 'Timeline 1';

/** Make sure the project lists its timelines (a project starts with one, implicitly). */
export function ensureTimelines(project) {
  if (Array.isArray(project.timelines) && project.timelines.length && project.timelineId) return project.timelines;
  const id = uid('tl');
  project.timelineId = id;
  project.timelines = [{ id, name: DEFAULT_NAME }];
  return project.timelines;
}

/** The open timeline's { id, name } (a stand-in when the project has never had more than one). */
export function activeTimeline(project) {
  const t = project.timelines?.find((x) => x.id === project.timelineId);
  return t ? { id: t.id, name: t.name } : { id: project.timelineId || null, name: DEFAULT_NAME };
}

/** End of the last clip of a list of tracks. */
function tracksLength(tracks) {
  return sequenceLength({ tracks });
}

/** Overview of every timeline, in order: { id, name, active, duration, settings, clips }. */
export function listTimelines(project) {
  if (!project.timelines?.length) {
    return [{ id: project.timelineId || null, name: DEFAULT_NAME, active: true, duration: tracksLength(project.tracks), settings: project.settings, clips: countClips(project.tracks) }];
  }
  return project.timelines.map((t) => {
    const active = t.id === project.timelineId;
    const src = active ? project : t;
    return { id: t.id, name: t.name, active, duration: tracksLength(src.tracks), settings: src.settings, clips: countClips(src.tracks) };
  });
}

function countClips(tracks) {
  let n = 0;
  for (const t of tracks || []) n += t.clips.length;
  return n;
}

/** The open timeline's contents, detached from the project. */
function takeActive(project) {
  const out = {};
  for (const k of TIMELINE_FIELDS) {
    if (project[k] !== undefined && project[k] !== null) out[k] = project[k];
    delete project[k];
  }
  return out;
}

/** Put a timeline's contents at the top level of the project. */
function putActive(project, contents) {
  for (const k of TIMELINE_FIELDS) {
    if (contents[k] !== undefined && contents[k] !== null) project[k] = contents[k];
    else delete project[k];
  }
  if (!project.markers) project.markers = [];
  if (!project.tracks) project.tracks = [makeTrack('video', { main: true })];
  if (!('cover' in project)) project.cover = null;
}

/** Contents of a timeline (the open one or a stored one), deep-copied. */
export function timelineContents(project, id) {
  if (id === project.timelineId || (!project.timelines?.length && !id)) {
    const out = {};
    for (const k of TIMELINE_FIELDS) if (project[k] !== undefined && project[k] !== null) out[k] = structuredClone(project[k]);
    return out;
  }
  const t = project.timelines?.find((x) => x.id === id);
  if (!t) return null;
  const out = {};
  for (const k of TIMELINE_FIELDS) if (t[k] !== undefined && t[k] !== null) out[k] = structuredClone(t[k]);
  return out;
}

/** Open another timeline: the current one is stored and the chosen one comes to the top level. */
export function switchTimeline(project, id) {
  ensureTimelines(project);
  if (id === project.timelineId) return false;
  const next = project.timelines.find((t) => t.id === id);
  if (!next) return false;
  const cur = project.timelines.find((t) => t.id === project.timelineId);
  const contents = takeActive(project);
  Object.assign(cur, contents);
  const incoming = {};
  for (const k of TIMELINE_FIELDS) {
    if (next[k] !== undefined) incoming[k] = next[k];
    delete next[k];
  }
  putActive(project, incoming);
  project.timelineId = id;
  return true;
}

/** A name that isn't taken yet: "Timeline 2", "Shorts copy 2"... */
export function uniqueTimelineName(project, base) {
  const names = new Set(listTimelines(project).map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  const stem = base.replace(/\s+\d+$/, '');
  for (let n = 2; ; n++) if (!names.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}

function nextDefaultName(project) {
  const used = new Set(listTimelines(project).map((t) => t.name.toLowerCase()));
  for (let n = 2; ; n++) if (!used.has(`timeline ${n}`)) return `Timeline ${n}`;
}

/**
 * Add an empty timeline after the open one (stored, not opened). settings
 * defaults to a copy of the open timeline's. Returns its id, or null when
 * the project already holds the most timelines allowed.
 */
export function addTimeline(project, { name, settings } = {}) {
  ensureTimelines(project);
  if (project.timelines.length >= MAX_TIMELINES) return null;
  const id = uid('tl');
  const entry = {
    id,
    name: uniqueTimelineName(project, cleanName(name) || nextDefaultName(project)),
    settings: structuredClone(settings || project.settings),
    tracks: [makeTrack('video', { main: true })],
    markers: [],
    cover: null,
  };
  const at = project.timelines.findIndex((t) => t.id === project.timelineId);
  project.timelines.splice(at + 1, 0, entry);
  return id;
}

/** Copy a timeline (clips get new ids so the copies are independent). Returns the new id. */
export function duplicateTimeline(project, id, name) {
  ensureTimelines(project);
  if (project.timelines.length >= MAX_TIMELINES) return null;
  const src = project.timelines.find((t) => t.id === id);
  const contents = timelineContents(project, id);
  if (!src || !contents) return null;
  contents.tracks = freshIds(contents.tracks || []);
  const copy = { id: uid('tl'), name: uniqueTimelineName(project, cleanName(name) || `${src.name} copy`), ...contents };
  if (!copy.markers) copy.markers = [];
  copy.markers = copy.markers.map((m) => ({ ...m, id: uid('m') }));
  project.timelines.splice(project.timelines.indexOf(src) + 1, 0, copy);
  return copy.id;
}

export function renameTimeline(project, id, name) {
  ensureTimelines(project);
  const t = project.timelines.find((x) => x.id === id);
  const clean = cleanName(name);
  if (!t || !clean || clean === t.name) return false;
  t.name = clean;
  return true;
}

/** Delete a timeline (opening its neighbor first when it is the open one). The last one can't go. */
export function deleteTimeline(project, id) {
  if (!project.timelines || project.timelines.length < 2) return false;
  const i = project.timelines.findIndex((t) => t.id === id);
  if (i < 0) return false;
  if (id === project.timelineId) switchTimeline(project, project.timelines[i + 1]?.id || project.timelines[i - 1].id);
  project.timelines.splice(project.timelines.findIndex((t) => t.id === id), 1);
  // Back to a plain single-timeline project.
  if (project.timelines.length === 1 && project.timelines[0].name === DEFAULT_NAME) {
    delete project.timelines;
    delete project.timelineId;
  }
  return true;
}

/** Move a timeline to a new position in the list. */
export function moveTimeline(project, id, index) {
  const list = project.timelines;
  const i = list?.findIndex((t) => t.id === id) ?? -1;
  if (i < 0) return false;
  const to = Math.max(0, Math.min(list.length - 1, index));
  if (to === i) return false;
  const [t] = list.splice(i, 1);
  list.splice(to, 0, t);
  return true;
}

/**
 * Put a copy of another timeline into the open one as a compound clip at
 * `start`. Returns the compound clip, or null (empty, missing or the open
 * timeline itself).
 */
export function insertTimeline(project, id, start, opts = {}) {
  if (!id || id === project.timelineId) return null;
  const src = project.timelines?.find((t) => t.id === id);
  if (!src?.tracks) return null;
  const tracks = freshIds(structuredClone(src.tracks));
  const length = tracksLength(tracks);
  if (length <= 0) return null;
  const clip = makeClip('compound', { start: Math.max(0, Math.round(start)), duration: length, name: src.name, sequence: { tracks } });
  addClip(project, clip, opts);
  return clip;
}

/** New ids for tracks, clips (deep) and clip groups. */
export function freshIds(tracks) {
  const groups = new Map();
  const walk = (list) => {
    for (const t of list) {
      t.id = uid('t');
      for (const c of t.clips) {
        c.id = uid('c');
        if (c.group) {
          if (!groups.has(c.group)) groups.set(c.group, uid('g'));
          c.group = groups.get(c.group);
        }
        if (c.type === 'compound' && c.sequence?.tracks) walk(c.sequence.tracks);
      }
    }
  };
  walk(tracks);
  return tracks;
}

/** Tracks of every stored (not open) timeline, for walks over all of a project's clips. */
export function storedTimelineTracks(project) {
  const out = [];
  for (const t of project.timelines || []) if (t.id !== project.timelineId && Array.isArray(t.tracks)) out.push(t.tracks);
  return out;
}

function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}
