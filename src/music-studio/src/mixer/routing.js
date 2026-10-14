// Pure mixer routing helpers: who feeds what, whether a send is allowed,
// and the edits the mixer's menus make (routes, channel inputs, solo). No DOM.
//
// Solo semantics (the engine applies these through mixerAudible): when any
// insert is soloed, an insert is heard only if it is soloed itself, routes
// into a soloed insert (directly or through others), or is reached from one
// (its returns and buses). The master is always heard. Mute always wins.

import * as E from '../model/edits.js';
import { MAX_GAIN } from './db.js';

/** "Master" or "3 Hats" for messages and lists. */
export function trackLabel(project, index) {
  const t = project.mixer[index];
  if (!t) return `Insert ${index}`;
  if (index === 0) return t.name || 'Master';
  const def = `Insert ${index}`;
  return t.name && t.name !== def ? `${index} ${t.name}` : def;
}

/** Rack channels whose output goes to insert `index`. */
export function channelsFeeding(project, index) {
  return project.channels.filter((c) => (c.mixer ?? 0) === index);
}

/** Map of insert index to the rack channels feeding it (one pass). */
export function channelInputs(project) {
  const map = new Map();
  for (const c of project.channels) {
    const i = c.mixer ?? 0;
    if (!map.has(i)) map.set(i, []);
    map.get(i).push(c);
  }
  return map;
}

/** Inserts that send into `index`, with their gains. */
export function sourcesOf(project, index) {
  const out = [];
  project.mixer.forEach((t, i) => {
    const g = t.routes?.[index];
    if (i !== index && g) out.push({ index: i, gain: g });
  });
  return out;
}

/** The sends of insert `index` ({ index, gain }), master first, then by index. */
export function sendsOf(project, index) {
  const r = project.mixer[index]?.routes || {};
  return Object.keys(r)
    .map(Number)
    .filter((k) => r[k] && project.mixer[k])
    .sort((a, b) => a - b)
    .map((k) => ({ index: k, gain: r[k] }));
}

/**
 * Whether insert `from` may send to `to`. Returns { ok, reason } where
 * reason explains a refusal in words for a toast.
 */
export function canRoute(project, from, to) {
  if (!project.mixer[from] || !project.mixer[to]) return { ok: false, reason: 'That insert does not exist.' };
  if (from === 0) return { ok: false, reason: 'The master is the final output and has no sends.' };
  if (from === to) return { ok: false, reason: 'An insert cannot send to itself.' };
  if (E.routesTo(project, to, from)) {
    return { ok: false, reason: `${trackLabel(project, to)} already feeds ${trackLabel(project, from)}, so this send would create a feedback loop.` };
  }
  return { ok: true, reason: '' };
}

/** Turns the send from -> to on (gain 1) or off. Refused routes leave the project unchanged. */
export function toggleRoute(project, from, to, gain = 1) {
  const on = Boolean(project.mixer[from]?.routes?.[to]);
  if (on) return E.setRoute(project, from, to, 0);
  if (!canRoute(project, from, to).ok) return project;
  return E.setRoute(project, from, to, Math.min(MAX_GAIN, gain));
}

/** Sets a send gain without turning a missing route on through a loop. */
export function setRouteGain(project, from, to, gain) {
  if (!project.mixer[from]?.routes?.[to] && !canRoute(project, from, to).ok) return project;
  return E.setRoute(project, from, to, Math.max(1e-6, Math.min(MAX_GAIN, gain)));
}

/** Removes every send of an insert except a unity route to the master. */
export function routeMasterOnly(project, index) {
  if (index === 0 || !project.mixer[index]) return project;
  const r = project.mixer[index].routes || {};
  const keys = Object.keys(r);
  if (keys.length === 1 && Number(keys[0]) === 0 && r[0] === 1) return project;
  return E.updateMixerTrack(project, index, { routes: { 0: 1 } });
}

/** Points the given rack channels at insert `index`. */
export function routeChannels(project, ids, index) {
  if (!project.mixer[index]) return project;
  let next = project;
  for (const id of ids) next = E.updateChannel(next, id, { mixer: index });
  return next;
}

/** Moves every channel feeding insert `from` to insert `to`. */
export function moveChannelInputs(project, from, to) {
  if (from === to) return project;
  return routeChannels(project, channelsFeeding(project, from).map((c) => c.id), to);
}

/** Whether some insert is soloed. */
export function anySolo(project) {
  return project.mixer.some((t, i) => i > 0 && t.solo);
}

/** Whether insert `index` is heard given mute and solo (see the header for the rules). */
export function mixerAudible(project, index) {
  const t = project.mixer[index];
  if (!t || t.mute) return false;
  if (index === 0 || !anySolo(project)) return true;
  if (t.solo) return true;
  for (let s = 1; s < project.mixer.length; s++) {
    if (!project.mixer[s].solo) continue;
    if (E.routesTo(project, index, s) || E.routesTo(project, s, index)) return true;
  }
  return false;
}

/**
 * Solo the way mixers do it: a plain click solos this insert alone (or clears
 * solo when it already is the only one); `add` toggles it in a multi-solo.
 */
export function soloInsert(project, index, { add = false } = {}) {
  const t = project.mixer[index];
  if (!t || index === 0) return project;
  if (add) return E.updateMixerTrack(project, index, { solo: !t.solo });
  const alone = t.solo && project.mixer.every((x, i) => i === index || i === 0 || !x.solo);
  let next = project;
  for (let i = 1; i < project.mixer.length; i++) next = E.updateMixerTrack(next, i, { solo: alone ? false : i === index });
  return next;
}

/** Everything the side panel's routing summary lists for one insert. */
export function routeSummary(project, index) {
  return {
    sends: sendsOf(project, index),
    receives: sourcesOf(project, index),
    channels: channelsFeeding(project, index),
  };
}
