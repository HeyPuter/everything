// Markers on an audio file. A cue marker has duration 0; a range marker spans
// [start, start + duration). Times are in frames. Types follow the common
// broadcast set: cue, cd (CD track), cart (cart timer), subclip.

let nextMarker = 1;

/**
 * Marker behavior from Preferences > Markers & Metadata (set by the app):
 * `undo` false makes marker-only edits change the document without adding
 * undo steps; `name` is the default name prefix for new markers; `lock`
 * keeps markers at their times when audio before them is deleted or inserted.
 */
export const markerOptions = { undo: true, name: 'Marker', lock: false };

/** True when `next` differs from `prev` only in its markers. */
export function markersOnlyChange(prev, next) {
  if (!prev || !next || prev === next || prev.markers === next.markers) return false;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (k !== 'markers' && prev[k] !== next[k]) return false;
  return true;
}

export const MARKER_TYPES = [
  { id: 'cue', label: 'Cue' },
  { id: 'cd', label: 'CD Track' },
  { id: 'cart', label: 'Cart Timer' },
  { id: 'subclip', label: 'Subclip' },
];

export function createMarker({ start, duration = 0, name, type = 'cue', description = '' }) {
  const id = `m${nextMarker++}`;
  return { id, name: name ?? '', start: Math.max(0, Math.round(start)), duration: Math.max(0, Math.round(duration)), type, description };
}

/** Next default name: "Marker 01", "Marker 02", ... not colliding with existing names. */
export function nextMarkerName(markers, prefix = markerOptions.name || 'Marker') {
  const used = new Set(markers.map((m) => m.name));
  for (let i = 1; ; i++) {
    const name = `${prefix} ${String(i).padStart(2, '0')}`;
    if (!used.has(name)) return name;
  }
}

export function sortMarkers(markers) {
  return markers.slice().sort((a, b) => a.start - b.start || a.duration - b.duration);
}

/**
 * Markers after removing frames [a, b): inside cues vanish, later ones shift, ranges shrink.
 * Locked markers keep their times; with the new file `length`, ones past it are dropped
 * and ranges running past it are cut at the end.
 */
export function shiftMarkersForDelete(markers = [], a, b, length) {
  if (markerOptions.lock) {
    if (!(length >= 0)) return markers;
    const out = [];
    for (const m of markers) {
      if (!m.duration) {
        if (m.start <= length) out.push(m);
      } else if (m.start < length) out.push(m.start + m.duration > length ? { ...m, duration: length - m.start } : m);
    }
    return out.length === markers.length && out.every((m, i) => m === markers[i]) ? markers : out;
  }
  const cut = b - a;
  const out = [];
  for (const m of markers) {
    const s = m.start;
    const e = m.start + m.duration;
    if (m.duration === 0) {
      if (s < a) out.push(m);
      else if (s >= b) out.push({ ...m, start: s - cut });
      else if (s === a) out.push(m);
      continue;
    }
    const ns = s < a ? s : s >= b ? s - cut : a;
    const ne = e <= a ? e : e >= b ? e - cut : a;
    if (ne > ns) out.push({ ...m, start: ns, duration: ne - ns });
  }
  return out;
}

/** Markers after inserting n frames at `at`: later markers shift; spanning ranges grow. */
export function shiftMarkersForInsert(markers = [], at, n) {
  if (markerOptions.lock) return markers;
  return markers.map((m) => {
    // A cue exactly at the insertion point stays put; ranges starting there move with their audio.
    if (m.start > at || (m.duration > 0 && m.start === at)) return { ...m, start: m.start + n };
    if (m.duration > 0 && m.start < at && m.start + m.duration > at) return { ...m, duration: m.duration + n };
    return m;
  });
}
