// Project files: JSON with a kind marker. parseProject validates and repairs
// everything it reads (unknown fields dropped, numbers clamped, references
// checked) so a damaged or hand-edited file can never break the editors.

import { uid, clamp } from '../lib/util.js';
import { INSTRUMENTS, defaultParams } from '../instruments/catalog.js';
import { EFFECTS, defaultEffectParams } from '../effects/catalog.js';
import { createMixerTrack, createTrack, createPattern, PROJECT_VERSION, MAX_FX_SLOTS, DEFAULT_KEY, COLORS } from './project.js';

export const KIND = 'music-studio-project';

export function serializeProject(project, view = {}) {
  const { ui, ...rest } = project;
  return JSON.stringify({ kind: KIND, ...rest, version: PROJECT_VERSION, ui: { pattern: view.pattern ?? ui?.pattern ?? null } });
}

const num = (v, def, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def);
const str = (v, def, max = 200) => (typeof v === 'string' ? v.slice(0, max) : def);
const bool = (v) => v === true;
const color = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
// Ids become object keys (samples, automation, pattern notes): names that
// collide with Object.prototype members are replaced.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const id = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) && !RESERVED.has(v) ? v : uid());
// Ids unique within one collection (a duplicated id would make edits hit the wrong item).
const uniqueId = (seen) => (v) => {
  let out = id(v);
  while (seen.has(out)) out = uid();
  seen.add(out);
  return out;
};
const own = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);

function params(defs, given, defaults) {
  const out = { ...defaults };
  if (given && typeof given === 'object') {
    for (const p of defs) if (typeof given[p.id] === 'number' && Number.isFinite(given[p.id])) out[p.id] = clamp(given[p.id], p.min, p.max);
  }
  return out;
}

/** Parses project JSON (string or object). Throws an Error with a user-facing message. */
export function parseProject(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error('The file is not a Music Studio project.');
    }
  }
  if (!data || typeof data !== 'object' || data.kind !== KIND) throw new Error('The file is not a Music Studio project.');
  if (Number(data.version) > PROJECT_VERSION) throw new Error('This project was saved by a newer version of Music Studio.');

  const samples = {};
  if (data.samples && typeof data.samples === 'object') {
    for (const s of Object.values(data.samples)) {
      if (!s || typeof s !== 'object') continue;
      const sid = id(s.id);
      samples[sid] = {
        id: sid,
        name: str(s.name, 'Sample'),
        path: typeof s.path === 'string' ? s.path.slice(0, 1024) : null,
        local: typeof s.local === 'string' ? s.local.slice(0, 200) : null,
        duration: num(s.duration, 0, 0),
        rate: num(s.rate, 44100, 8000, 384000),
        channels: num(s.channels, 2, 1, 2),
      };
    }
  }

  const mixerIn = Array.isArray(data.mixer) && data.mixer.length ? data.mixer.slice(0, 128) : [];
  const slotId = uniqueId(new Set());
  const mixer = (mixerIn.length ? mixerIn : Array.from({ length: 17 }, () => ({}))).map((t, i) => {
    const base = createMixerTrack(i);
    const fx = Array.isArray(t?.fx)
      ? t.fx
          .filter((s) => s && EFFECTS[s.type])
          .slice(0, MAX_FX_SLOTS)
          .map((s) => ({ id: slotId(s.id), type: s.type, on: s.on !== false, mix: num(s.mix, 1, 0, 1), params: params(EFFECTS[s.type].params, s.params, defaultEffectParams(s.type)) }))
      : [];
    return {
      ...base,
      id: id(t?.id),
      name: str(t?.name, base.name, 60),
      color: color(t?.color),
      volume: num(t?.volume, base.volume, 0, 1.25),
      pan: num(t?.pan, 0, -1, 1),
      width: num(t?.width, 1, 0, 2),
      mute: bool(t?.mute),
      solo: bool(t?.solo),
      fx,
      routes: i === 0 ? {} : {},
    };
  });
  // Routes after all tracks exist, refusing self, master-out and out-of-range targets.
  mixerIn.forEach((t, i) => {
    if (i === 0) return;
    const r = {};
    if (t?.routes && typeof t.routes === 'object') {
      for (const [k, g] of Object.entries(t.routes)) {
        const to = Number(k);
        if (Number.isInteger(to) && to >= 0 && to < mixer.length && to !== i) r[to] = num(g, 1, 0, 2);
      }
    }
    mixer[i].routes = r;
  });
  if (!mixerIn.length) for (let i = 1; i < mixer.length; i++) mixer[i].routes = { 0: 1 };

  const channelId = uniqueId(new Set());
  const channels = (Array.isArray(data.channels) ? data.channels : [])
    .filter((c) => c && INSTRUMENTS[c.type])
    .slice(0, 512)
    .map((c) => ({
      id: channelId(c.id),
      name: str(c.name, INSTRUMENTS[c.type].label, 60),
      color: color(c.color) || COLORS[6],
      type: c.type,
      params: params(INSTRUMENTS[c.type].params, c.params, defaultParams(c.type)),
      sample: own(samples, c.sample) ? c.sample : null,
      volume: num(c.volume, 0.78, 0, 1.25),
      pan: num(c.pan, 0, -1, 1),
      pitch: num(c.pitch, 0, -4800, 4800),
      mixer: Math.round(num(c.mixer, 0, 0, mixer.length - 1)),
      mute: bool(c.mute),
      solo: bool(c.solo),
      root: Math.round(num(c.root, DEFAULT_KEY, 0, 127)),
    }));
  const channelIds = new Set(channels.map((c) => c.id));

  const noteId = uniqueId(new Set());
  const note = (n) => ({
    id: noteId(n.id),
    key: Math.round(num(n.key, DEFAULT_KEY, 0, 127)),
    pos: Math.max(0, Math.round(num(n.pos, 0))),
    len: Math.max(1, Math.round(num(n.len, 24, 1, 1e7))),
    vel: num(n.vel, 0.78, 0, 1),
    pan: num(n.pan, 0, -1, 1),
  });
  const patternId = uniqueId(new Set());
  let patterns = (Array.isArray(data.patterns) ? data.patterns : []).slice(0, 999).map((p, i) => {
    const notes = {};
    if (p?.notes && typeof p.notes === 'object') {
      for (const [cid, list] of Object.entries(p.notes)) {
        if (!channelIds.has(cid) || !Array.isArray(list)) continue;
        const ns = list.filter((n) => n && typeof n === 'object').slice(0, 100000).map(note);
        if (ns.length) notes[cid] = ns.sort((a, b) => a.pos - b.pos || a.key - b.key);
      }
    }
    return { id: patternId(p?.id), name: str(p?.name, `Pattern ${i + 1}`, 60), color: color(p?.color), notes, length: p?.length ? Math.round(num(p.length, 0, 1, 1e7)) : null };
  });
  if (!patterns.length) patterns = [createPattern(0)];
  const patternIds = new Set(patterns.map((p) => p.id));

  const automation = {};
  if (data.automation && typeof data.automation === 'object') {
    for (const a of Object.values(data.automation)) {
      if (!a || typeof a !== 'object' || !a.target || typeof a.target !== 'object') continue;
      const aid = id(a.id);
      const pts = (Array.isArray(a.points) ? a.points : [])
        .filter((pt) => pt && typeof pt === 'object')
        .slice(0, 10000)
        .map((pt) => ({ t: Math.max(0, Math.round(num(pt.t, 0))), v: num(pt.v, 0.5, 0, 1), ...(typeof pt.c === 'number' ? { c: num(pt.c, 0, -1, 1) } : {}) }))
        .sort((x, y) => x.t - y.t);
      automation[aid] = { id: aid, name: str(a.name, 'Automation', 60), target: sanitizeTarget(a.target), points: pts.length ? pts : [{ t: 0, v: 0.5 }] };
      if (color(a.color)) automation[aid].color = color(a.color);
    }
  }

  const trackId = uniqueId(new Set());
  const trackCount = Math.max(16, Array.isArray(data.tracks) ? Math.min(data.tracks.length, 500) : 0);
  const tracks = Array.from({ length: trackCount }, (_, i) => {
    const t = data.tracks?.[i];
    const base = createTrack(i);
    return { ...base, id: trackId(t?.id), name: str(t?.name, base.name, 60), color: color(t?.color), mute: bool(t?.mute), solo: bool(t?.solo), height: Math.round(num(t?.height, 56, 24, 240)) };
  });

  const clipId = uniqueId(new Set());
  const clips = (Array.isArray(data.clips) ? data.clips : [])
    .filter((c) => c && ((c.kind === 'pattern' && patternIds.has(c.ref)) || (c.kind === 'audio' && channelIds.has(c.ref)) || (c.kind === 'auto' && own(automation, c.ref))))
    .slice(0, 50000)
    .map((c) => ({
      id: clipId(c.id),
      kind: c.kind,
      track: Math.round(num(c.track, 0, 0, tracks.length - 1)),
      start: Math.max(0, Math.round(num(c.start, 0))),
      len: Math.max(1, Math.round(num(c.len, 384, 1, 1e8))),
      offset: Math.max(0, Math.round(num(c.offset, 0))),
      ref: c.ref,
      mute: bool(c.mute),
    }));

  const loopStart = Math.max(0, Math.round(num(data.loop?.start, 0)));
  const loopEnd = Math.round(num(data.loop?.end, 0));
  const loop = data.loop && loopEnd > loopStart ? { start: loopStart, end: loopEnd } : null;
  const markerId = uniqueId(new Set());
  const markers = (Array.isArray(data.markers) ? data.markers : []).filter((m) => m && typeof m === 'object').slice(0, 1000).map((m) => ({ id: markerId(m.id), pos: Math.max(0, Math.round(num(m.pos, 0))), name: str(m.name, 'Marker', 60) }));
  const sig = Array.isArray(data.sig) && [1, 2, 4, 8, 16].includes(data.sig[1]) ? [Math.round(num(data.sig[0], 4, 1, 16)), data.sig[1]] : [4, 4];

  return {
    version: PROJECT_VERSION,
    name: str(data.name, 'Untitled', 120),
    bpm: num(data.bpm, 130, 10, 522),
    sig,
    swing: num(data.swing, 0, 0, 1),
    masterPitch: num(data.masterPitch, 0, -1200, 1200),
    channels,
    patterns,
    tracks,
    clips,
    automation,
    mixer,
    samples,
    loop,
    markers,
    ui: { pattern: typeof data.ui?.pattern === 'string' && patternIds.has(data.ui.pattern) ? data.ui.pattern : patterns[0].id },
  };
}

function sanitizeTarget(t) {
  switch (t.kind) {
    case 'channel':
      return { kind: 'channel', id: str(t.id, ''), param: str(t.param, 'volume', 40) };
    case 'mixer':
      return { kind: 'mixer', track: Math.round(num(t.track, 0, 0, 127)), param: ['volume', 'pan', 'width'].includes(t.param) ? t.param : 'volume' };
    case 'fx':
      return { kind: 'fx', track: Math.round(num(t.track, 0, 0, 127)), slot: str(t.slot, ''), param: str(t.param, 'mix', 40) };
    case 'tempo':
      return { kind: 'tempo' };
    default:
      return { kind: 'mixer', track: 0, param: 'volume' };
  }
}
