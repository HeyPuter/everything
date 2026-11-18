/** A transition fragment retained when its other source is outside a flattened window. */
import { captureClock, normalizeTiming } from './inherited-motion.js';

/** Entries pair each restored clip with its original source and its window in the sequence. */
export function retainClippedTransitions(track, entries, placePartner) {
  const fragments = new Map();
  for (let i = 0; i < track.clips.length - 1; i++) {
    const a = track.clips[i], b = track.clips[i + 1], tr = a.transition;
    const cut = a.start + a.duration;
    if (!tr || a.disabled || b.disabled || Math.abs(b.start - cut) > 2000 || !['video', 'image'].includes(b.type)) continue;
    const outgoing = entries.filter(e => e.source === a);
    const incoming = entries.filter(e => e.source === b);
    const intact = outgoing.find(e => e.end === cut && e.clip.duration >= tr.duration && incoming.some(n => n.start === cut && n.clip.duration >= tr.duration));
    for (const e of [...outgoing, ...incoming]) {
      if (intact && (e === intact || e.source === b && e.start === cut)) continue;
      if (e.source === a) e.clip.transition = null;
      const start = Math.max(e.start, cut - tr.duration / 2), end = Math.min(e.end, cut + tr.duration / 2);
      if (start >= end) continue;
      const other = e.source === a ? b : a;
      const partner = structuredClone(other);
      delete partner.transitionSlices;
      partner.transition = null;
      placePartner(partner);
      partner.start = 0;
      partner.muted = true;
      if (!fragments.has(e.clip)) fragments.set(e.clip, []);
      fragments.get(e.clip).push({
        id: tr.id, duration: tr.duration, cut: cut - e.start,
        start: start - e.start, end: end - e.start, incoming: e.source === b,
        partnerOffset: e.start - other.start, partner, clock: captureClock(e.clip),
      });
    }
  }
  for (const [clip, slices] of fragments) clip.transitionSlices = [...slices, ...(clip.transitionSlices || [])];
}

/** Partners are plain media sources, never recursively embedded transition fragments. */
export function normalizeTransitionSlices(raw, normalizeClip) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || !['duration', 'cut', 'start', 'end', 'partnerOffset'].every(k => Number.isFinite(item[k])) || item.duration < 100_000 || item.end <= item.start) continue;
    if (!item.partner || !['video', 'image'].includes(item.partner.type)) continue;
    const partner = normalizeClip({ ...item.partner, start: 0, transition: null, transitionSlices: undefined });
    const clock = normalizeTiming({ effects: { duration: item.duration, clock: item.clock } })?.effects.clock;
    if (!partner || !clock) continue;
    const inherited = item.inherited && normalizeClip({ type: 'video', inherited: item.inherited }).inherited;
    out.push({ id: item.id, duration: item.duration, cut: item.cut, start: item.start, end: item.end, incoming: item.incoming === true, partnerOffset: item.partnerOffset, partner, clock, ...(inherited ? { inherited } : {}) });
  }
  return out.length ? out : null;
}
