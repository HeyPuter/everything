// Editor behavior shared by the Waveform and Multitrack editors that follows
// Preferences: mouse-wheel zoom (rate and anchor) and how the view follows the
// playhead during playback (page by page or centered).

/** The shortest view (frames) either editor shows; zooms stop there instead of drifting. */
export const MIN_VIEW_FRAMES = 16;

/**
 * Zooms `doc`'s view for a wheel event. The zoom keeps the frame under the
 * pointer in place, or the playhead when the anchor preference says so (and
 * the playhead is in view). `x` is the pointer position in pixels, `width`
 * the editor width.
 */
export function wheelZoom(app, doc, e, x, width) {
  const v = doc.view;
  const span = v.end - v.start;
  const rate = Math.max(0.1, Math.min(8, Number(app.prefs.get('wheelZoomFactor')) || 1));
  const factor = Math.pow(1.0025, e.deltaY * (e.ctrlKey ? 3 : 1) * rate);
  let anchorX = x;
  if (app.prefs.get('wheelZoomAnchor') === 'playhead') {
    const p = app.playhead;
    if (p >= v.start && p <= v.end) anchorX = ((p - v.start) / span) * width;
  }
  const f = v.start + (anchorX / width) * span;
  // Past the deepest zoom the span stays put, and so does the anchor (the view would scroll).
  const nspan = Math.max(MIN_VIEW_FRAMES, span * factor);
  const start = f - (anchorX / width) * nspan;
  doc.setView(start, start + nspan);
}

/** View span factor for one Zoom In (Time) step: 0.5 halves the view (Preferences > General). */
export function zoomInFactor(app) {
  const pct = Number(app.prefs.get('zoomStep'));
  return 1 - Math.max(5, Math.min(90, Number.isFinite(pct) ? pct : 50)) / 100;
}

/**
 * Keeps the playhead in view while playing. 'page' turns a page when the
 * playhead leaves the view; 'center' scrolls continuously with the playhead
 * in the middle (until the view reaches the start).
 */
export function followPlayhead(app, doc, mode) {
  if (!app.prefs.get('autoScroll')) return;
  const p = app.playhead;
  const v = doc.view;
  const span = v.end - v.start;
  if (mode === 'center') {
    const start = Math.max(0, p - span / 2);
    if (Math.abs(start - v.start) >= span / 2000) doc.setView(start, start + span);
    return;
  }
  if (p > v.end || p < v.start) doc.setView(p - span * 0.05, p - span * 0.05 + span);
}

/** Crossfade length in frames for effect and amplitude edit boundaries (0 when off). */
export function editSmoothFrames(app, rate) {
  if (!app.prefs.get('smoothEdits')) return 0;
  return Math.round((Math.max(0, Math.min(1000, Number(app.prefs.get('smoothEditsMs')) || 0)) / 1000) * rate);
}

/** Crossfade length in frames for delete and cut splices (0 when off). */
export function deleteSmoothFrames(app, rate) {
  if (!app.prefs.get('smoothDelete')) return 0;
  return Math.round((Math.max(0, Math.min(1000, Number(app.prefs.get('smoothDeleteMs')) || 0)) / 1000) * rate);
}

/** Fade curve value for new fades (see FADE_CURVES in model/session-edits.js). */
export const FADE_CURVE_VALUES = { linear: 0, log: 0.5, cosine: 2 };

export function defaultFadeCurve(app) {
  return FADE_CURVE_VALUES[app.prefs.get('defaultFadeCurve')] ?? 0;
}
