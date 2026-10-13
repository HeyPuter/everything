// The audio part of the video timeline view: a header row, one row per
// audio track (name, mute and solo) with its clips drawn as waveforms with
// their gain envelope and fade handles, and a properties bar for the
// selected clip or track. Clips drag to move (also to another track), their
// ends drag to trim and the fade handles drag to set fades; moves and trims
// snap to the playhead and to clip edges.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import {
  audioTracks,
  clipSpan,
  dbToGain,
  envelopePoints,
  findAudioClip,
  snapTime,
  type AudioClip,
  type ClipSpan,
} from '../../model/audio-timeline';
import { clipEnd, type VideoTimeline } from '../../model/video-timeline';
import { timecode } from '../../model/video-timeline-ops';
import { peakColumns, waveformPath } from '../../imaging/audio/peaks';
import { audioFailed, audioPeaks } from './audio-media';
import { clipName, dragResult, type AudioDragMode } from './audio-commands';
import { selectedAudioClips, selectedAudioTrack, videoView } from './video-state';

const maxColumns = 1500;
const fmtDb = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;
const secs = (s: number) => `${s.toFixed(2)} s`;

// Waveform paths by source range and size (rebuilt only when these change).
const paths = new Map<string, string>();
function wave(e: Editor, span: ClipSpan, width: number, gain: number) {
  const src = span.source!;
  const cols = Math.max(1, Math.min(maxColumns, Math.round(width)));
  const key = `${src.asset}|${span.in}|${span.length}|${cols}|${gain}`;
  let d = paths.get(key);
  if (d === undefined) {
    const peaks = audioPeaks(e.session, src);
    if (!peaks) return audioFailed(src) ? '<span class="vt-wave-note">Cannot decode</span>' : '<span class="vt-wave-pending" aria-hidden="true"></span>';
    d = waveformPath(peakColumns(peaks, span.in, span.length, cols), dbToGain(gain));
    paths.set(key, d);
    if (paths.size > 600) paths.delete(paths.keys().next().value!);
  }
  return `<svg class="vt-wave" viewBox="0 -1 ${cols} 2" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}
/** The gain envelope over a clip `w` px wide with fades in px. */
function envelope(w: number, fi: number, fo: number) {
  // The corners the mix and playback use (overlapping fades meet where they cross).
  const pts = envelopePoints({ gain: 1, fadeIn: Math.min(fi, w), fadeOut: Math.min(fo, w), length: w }).map(([x, g]) => `${x},${100 - g * 100}`);
  const shade = fi > 0 || fo > 0 ? `<polygon class="vt-env-shade" points="0,0 ${w},0 ${[...pts].reverse().join(' ')}"/>` : '';
  return `<svg class="vt-env" viewBox="0 0 ${Math.max(1, w)} 100" preserveAspectRatio="none" aria-hidden="true">${shade}<polyline points="${pts.join(' ')}"/></svg>`;
}

/** Handle position: at the end of the fade, kept inside the clip. */
const handleAt = (px: number, width: number) => Math.max(4.5, Math.min(px, width - 4.5));
function clipHtml(e: Editor, tl: VideoTimeline, c: AudioClip, zoom: number, silent: boolean, selected: Set<string>) {
  const span = clipSpan(e.doc, c);
  if (!span || !span.source) return '';
  const px = tl.fps * zoom;
  const left = span.start * px,
    width = Math.max(3, span.length * px);
  const fi = (c.fadeIn ?? 0) * px,
    fo = (c.fadeOut ?? 0) * px;
  const name = clipName(e.doc, c);
  const gain = c.gain ?? 0;
  const range = `${timecode(span.start * tl.fps, tl.fps)} to ${timecode((span.start + span.length) * tl.fps, tl.fps)}`;
  const tip = `${name}: ${range}${gain ? `, ${fmtDb(gain)}` : ''}${span.linked ? ' (sound of the video layer; moves with its clip)' : ''}${span.muted ? ' (muted)' : ''}`;
  const cls = `vt-clip audio${span.linked ? ' linked' : ''}${selected.has(c.id) ? ' selected' : ''}${silent || span.muted ? ' muted' : ''}`;
  return `<div class="${cls}" data-audio-clip="${c.id}" style="left:${left}px;width:${width}px" title="${escapeXML(tip)}"><span class="vt-trim start" data-trim="start" title="Drag to trim the start"></span>${wave(e, span, width, gain)}${envelope(width, fi, fo)}<span class="vt-afade-handle in" data-afade="in" style="left:${handleAt(fi, width)}px" title="Drag to set the fade in"></span><span class="vt-afade-handle out" data-afade="out" style="right:${handleAt(fo, width)}px" title="Drag to set the fade out"></span><span class="vt-clip-label">${span.linked ? svg('link', 11) : svg('audio-wave', 11)}${escapeXML(name)}</span><span class="vt-trim end" data-trim="end" title="Drag to trim the end"></span></div>`;
}

/** The audio header row and track rows. */
export function audioRowsHtml(e: Editor, tl: VideoTimeline, zoom: number) {
  const tracks = audioTracks(tl);
  const solo = tracks.some((t) => t.solo);
  const view = videoView(e);
  const selected = new Set(selectedAudioClips(e));
  const current = selectedAudioTrack(e)?.id ?? (view.audioTrack || tracks[0].id);
  const header = `<div class="vt-row vt-audio-header"><div class="vt-head"><span class="vt-icon" aria-hidden="true">${svg('speaker', 13)}</span><span class="vt-name">Audio</span><span class="vt-spacer"></span><button class="icon-button" data-command="timeline.audio-add" title="Add audio…" aria-label="Add audio">${svg('audio-add', 13)}</button><button class="icon-button" data-command="timeline.audio-track-new" title="New audio track" aria-label="New audio track">${svg('plus', 13)}</button></div><div class="vt-lane"></div></div>`;
  const rows = tracks
    .map((t) => {
      const silent = !!t.muted || (solo && !t.solo);
      const sel = t.id === current;
      const head = `<div class="vt-head" data-audio-track="${t.id}"><span class="vt-icon" aria-hidden="true">${svg('audio-wave', 13)}</span><span class="vt-name" title="${escapeXML(t.name)} (double-click to rename)">${escapeXML(t.name)}</span>${t.volume ? `<span class="vt-track-volume">${fmtDb(t.volume)}</span>` : ''}<button class="icon-button vt-track-toggle" data-command="timeline.audio-track-mute" data-arg="${t.id}" aria-pressed="${!!t.muted}" title="${t.muted ? 'Unmute' : 'Mute'} this track" aria-label="Mute ${escapeXML(t.name)}">${svg(t.muted ? 'speaker-off' : 'speaker', 13)}</button><button class="icon-button vt-track-toggle" data-command="timeline.audio-track-solo" data-arg="${t.id}" aria-pressed="${!!t.solo}" title="${t.solo ? 'Stop playing only this track' : 'Play only solo tracks (solo)'}" aria-label="Solo ${escapeXML(t.name)}">${svg('headphones', 13)}</button></div>`;
      const clips = t.clips.map((c) => clipHtml(e, tl, c, zoom, silent, selected)).join('');
      return `<div class="vt-row vt-track vt-audio-track${sel ? ' selected' : ''}" data-audio-row="${t.id}">${head}<div class="vt-lane vt-audio-lane" data-audio-lane="${t.id}">${clips}</div></div>`;
    })
    .join('');
  return header + rows;
}

/** The properties bar for the selected clip (or track). */
export function audioPropsHtml(e: Editor, tl: VideoTimeline) {
  const [id] = selectedAudioClips(e);
  const hit = id ? findAudioClip(tl, id) : undefined;
  const track = hit?.track ?? (videoView(e).audioTrack ? selectedAudioTrack(e) : undefined);
  if (!track) return '';
  const vol = track.volume ?? 0;
  const volume = `<label class="vt-ap-field" title="Volume of the track (dB)">Track volume<input type="range" min="-40" max="12" step="0.5" value="${vol}" data-audio="volume" data-track="${track.id}" aria-label="Track volume (dB)"><output>${fmtDb(vol)}</output></label>`;
  if (!hit) return `<span class="vt-ap-name">${svg('audio-wave', 13)}${escapeXML(track.name)}</span>${volume}`;
  const c = hit.clip;
  const span = clipSpan(e.doc, c);
  const max = span ? Math.round(span.length * 1000) / 1000 : 0;
  const g = c.gain ?? 0;
  const linked = span?.linked;
  const layerMuted = linked && span?.muted;
  return `<span class="vt-ap-name" title="${escapeXML(clipName(e.doc, c))}">${svg(linked ? 'link' : 'audio-wave', 13)}${escapeXML(clipName(e.doc, c))}</span>
<label class="vt-ap-field" title="Gain of the clip (dB)">Gain<input type="range" min="-40" max="12" step="0.5" value="${g}" data-audio="gain" data-clip="${c.id}" aria-label="Clip gain (dB)"><output>${fmtDb(g)}</output></label>
<label class="vt-ap-field" title="Length of the fade in (seconds)">Fade in<input type="number" min="0" max="${max}" step="0.05" value="${c.fadeIn ?? 0}" data-audio="fadeIn" data-clip="${c.id}" aria-label="Fade in (seconds)">s</label>
<label class="vt-ap-field" title="Length of the fade out (seconds)">Fade out<input type="number" min="0" max="${max}" step="0.05" value="${c.fadeOut ?? 0}" data-audio="fadeOut" data-clip="${c.id}" aria-label="Fade out (seconds)">s</label>
<span class="timeline-sep"></span>${volume}
${linked ? `<span class="timeline-sep"></span><button class="icon-button" data-command="timeline.audio-video-mute" data-arg="${escapeXML(c.link!)}" aria-pressed="${!!layerMuted}" title="${layerMuted ? 'Unmute' : 'Mute'} the sound of the video layer" aria-label="Mute the sound of the video layer">${svg(layerMuted ? 'speaker-off' : 'speaker', 15)}</button><button class="icon-button" data-command="timeline.audio-unlink" title="Unlink the sound from its video clip" aria-label="Unlink audio">${svg('unlink', 15)}</button>` : ''}
<span class="vt-ap-length">${span ? secs(span.length) : ''}</span>`;
}

// ----- Gestures -----

export type AudioDrag =
  | { kind: 'audio'; ids: string[]; mode: AudioDragMode; x0: number; moved: boolean; d: number; toTrack?: string; snap: boolean }
  | { kind: 'afade'; id: string; edge: 'in' | 'out'; x0: number; base: number; length: number; value: number };

/** Times (seconds) that moving and trimming snap to. */
function snapTargets(e: Editor, tl: VideoTimeline, skip: Set<string>) {
  const out = [0, tl.current / tl.fps, tl.duration / tl.fps];
  for (const t of tl.audio ?? [])
    for (const c of t.clips) {
      if (skip.has(c.id)) continue;
      const s = clipSpan(e.doc, c);
      if (s) out.push(s.start, s.start + s.length);
    }
  for (const [id, c] of Object.entries(tl.clips)) {
    if ([...skip].some((x) => findAudioClip(tl, x)?.clip.link === id)) continue;
    out.push(c.start / tl.fps, clipEnd(c) / tl.fps);
  }
  if (tl.work) out.push(tl.work[0] / tl.fps, tl.work[1] / tl.fps);
  return out;
}

/** Start a drag on an audio clip (or its fade handle); selects the clip. */
export function beginAudioDrag(e: Editor, ev: PointerEvent, target: HTMLElement): AudioDrag | undefined {
  const tl = e.doc.timeline;
  const el = target.closest<HTMLElement>('[data-audio-clip]');
  if (!tl || !el) return undefined;
  const id = el.dataset.audioClip!;
  const view = videoView(e);
  const hit = findAudioClip(tl, id);
  if (!hit) return undefined;
  view.audioTrack = hit.track.id;
  view.keys = [];
  const add = ev.shiftKey || ev.metaKey || ev.ctrlKey;
  if (add) view.audioClips = view.audioClips.includes(id) ? view.audioClips.filter((x) => x !== id) : [...view.audioClips, id];
  else if (!view.audioClips.includes(id)) view.audioClips = [id];
  el.classList.add('selected');
  const fade = target.closest<HTMLElement>('[data-afade]')?.dataset.afade as 'in' | 'out' | undefined;
  if (fade) {
    const span = clipSpan(e.doc, hit.clip);
    const base = (fade === 'in' ? hit.clip.fadeIn : hit.clip.fadeOut) ?? 0;
    view.audioClips = [id];
    return { kind: 'afade', id, edge: fade, x0: ev.clientX, base, length: span?.length ?? 0, value: base };
  }
  const trim = target.closest<HTMLElement>('[data-trim]')?.dataset.trim as 'start' | 'end' | undefined;
  const ids = trim ? [id] : selectedAudioClips(e).length ? selectedAudioClips(e) : [id];
  return { kind: 'audio', ids: ids.includes(id) ? [id, ...ids.filter((x) => x !== id)] : [id], mode: trim ?? 'move', x0: ev.clientX, moved: false, d: 0, snap: true };
}

/** Preview a drag: clips move in place, the target track is highlighted. */
export function moveAudioDrag(e: Editor, g: AudioDrag, ev: PointerEvent, host: HTMLElement, zoom: number) {
  const tl = e.doc.timeline!;
  const px = tl.fps * zoom;
  if (Math.abs(ev.clientX - g.x0) > 3) (g as { moved?: boolean }).moved = true;
  if (g.kind === 'afade') {
    const dx = (ev.clientX - g.x0) / px;
    g.value = Math.max(0, Math.min(g.length, g.base + (g.edge === 'in' ? dx : -dx)));
    const el = host.querySelector<HTMLElement>(`[data-audio-clip="${CSS.escape(g.id)}"]`);
    const hit = findAudioClip(tl, g.id);
    if (el && hit) {
      const fi = (g.edge === 'in' ? g.value : (hit.clip.fadeIn ?? 0)) * px,
        fo = (g.edge === 'out' ? g.value : (hit.clip.fadeOut ?? 0)) * px;
      el.querySelector('.vt-env')!.outerHTML = envelope(el.offsetWidth, fi, fo);
      el.querySelector<HTMLElement>(`.vt-afade-handle.${g.edge}`)!.style[g.edge === 'in' ? 'left' : 'right'] = `${handleAt(g.edge === 'in' ? fi : fo, el.offsetWidth)}px`;
      readout(host, `Fade ${g.edge}: ${secs(g.value)}`);
    }
    return;
  }
  // Vertical moves pick the track under the pointer.
  if (g.mode === 'move') {
    const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-audio-row]');
    g.toTrack = lane?.dataset.audioRow;
    host.querySelectorAll('.vt-audio-track.drop-target').forEach((r) => r.classList.remove('drop-target'));
    const from = findAudioClip(tl, g.ids[0])?.track.id;
    if (g.toTrack && g.toTrack !== from) lane!.classList.add('drop-target');
    if (g.toTrack !== from) (g as { moved?: boolean }).moved = true;
  }
  if (!g.moved) return;
  let d = (ev.clientX - g.x0) / px;
  const anchor = findAudioClip(tl, g.ids[0]);
  const s = anchor && clipSpan(e.doc, anchor.clip);
  if (!s) return;
  const snapped = ev.altKey ? undefined : snapDelta(snapTargets(e, tl, new Set(g.ids)), s, g.mode, d, 8 / px);
  d = snapped ?? Math.round(d * tl.fps) / tl.fps;
  g.d = d;
  for (const id of g.ids) {
    const hit = findAudioClip(tl, id);
    const el = host.querySelector<HTMLElement>(`[data-audio-clip="${CSS.escape(id)}"]`);
    if (!hit || !el) continue;
    const span = previewSpan(e, hit.clip, g.mode, d);
    if (!span) continue;
    el.style.left = `${span.start * px}px`;
    el.style.width = `${Math.max(3, span.length * px)}px`;
    if (id === g.ids[0]) readout(host, `${timecode(span.start * tl.fps, tl.fps)} to ${timecode((span.start + span.length) * tl.fps, tl.fps)}${snapped !== undefined ? ' (snapped)' : ''}`);
  }
}
function snapDelta(targets: number[], s: ClipSpan, mode: AudioDragMode, d: number, tolerance: number) {
  const edges = mode === 'move' ? [s.start, s.start + s.length] : mode === 'start' ? [s.start] : [s.start + s.length];
  let best: number | undefined,
    dist = Infinity;
  for (const edge of edges) {
    const t = snapTime(edge + d, targets, tolerance);
    if (t !== edge + d && Math.abs(t - (edge + d)) < dist) {
      dist = Math.abs(t - (edge + d));
      best = t - edge;
    }
  }
  return best;
}
/** Where a clip would be after the drag (seconds). */
function previewSpan(e: Editor, c: AudioClip, mode: AudioDragMode, d: number) {
  const tl = e.doc.timeline!;
  const r = dragResult(e.doc, c, mode, d);
  if (r?.audio) return r.audio;
  if (r?.video) {
    const base = clipSpan(e.doc, c);
    if (!base) return undefined;
    const v = r.video.clip;
    return { start: v.start / tl.fps, length: Math.min(v.length / tl.fps, base.source!.seconds - v.in / tl.fps) };
  }
  return undefined;
}
function readout(host: HTMLElement, text: string) {
  const label = host.querySelector('.vt-time');
  if (label) label.textContent = text;
}

/** Finish a drag: apply it as one undo step (a click only selects). */
export async function endAudioDrag(e: Editor, g: AudioDrag, ev: PointerEvent, host: HTMLElement) {
  host.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
  if (ev.type !== 'pointerup') return;
  const m = await import('./audio-commands');
  if (g.kind === 'afade') {
    if (Math.abs(g.value - g.base) < 1e-4) return;
    await e.runCommand('timeline.audio-set', { clip: g.id, [g.edge === 'in' ? 'fadeIn' : 'fadeOut']: Math.round(g.value * 1000) / 1000 });
    return;
  }
  const from = findAudioClip(e.doc.timeline!, g.ids[0])?.track.id;
  const toTrack = g.mode === 'move' && g.toTrack && g.toTrack !== from ? g.toTrack : undefined;
  if (!g.moved || (!g.d && !toTrack)) return;
  await m.applyDrag(e, g.ids, g.mode, g.d, toTrack);
}
