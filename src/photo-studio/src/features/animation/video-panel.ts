// The video timeline view in the Timeline panel: a time ruler with the
// work area and the current-time indicator, one track per layer (children of
// open groups indented) with its clip, keyframe lanes for position, opacity
// and style, audio tracks under the layer tracks (audio-panel.ts), and
// transport and zoom controls. Clips drag to move, their ends drag to trim,
// keyframes drag to retime; the ruler scrubs.
import type { Editor } from '../../editor';
import { commands } from '../../app/registry';
import { svg } from '../../app/icons';
import { showContextMenu } from '../../app/menubar';
import { escapeXML } from '../../model/assets';
import type { Layer } from '../../model/document';
import {
  canAnimate,
  clipEnd,
  clipOf,
  contentFrame,
  frameRates,
  keyProperties,
  transitionKinds,
  type Clip,
  type KeyProperty,
  type Transition,
  type VideoTimeline,
} from '../../model/video-timeline';
import { contentLength, fpsLabel, moveClip, rulerStep, timecode, trimClipEnd, trimClipStart, workArea } from '../../model/video-timeline-ops';
import { isVideoLayer, timelineOf, videoPlayback, videoView, isVideoPlaying, type KeyRef } from './video-state';
import { setTime } from './video-frames';
import { onVideoPlayback } from './video-playback';
import * as cmd from './video-commands';
import { audioPropsHtml, audioRowsHtml, beginAudioDrag, endAudioDrag, moveAudioDrag, type AudioDrag } from './audio-panel';
import { onAudioDecoded } from './audio-media';
import { scrubAudio } from './audio-playback';
import { audioClipMenu, audioTrackMenu } from './audio';

const HEAD = 200;
const minZoom = 0.02;
const maxZoom = 48;
const propNames: Record<KeyProperty, string> = { position: 'Position', opacity: 'Opacity', style: 'Style' };

type Drag =
  | { kind: 'scrub' }
  | { kind: 'work'; edge: 'start' | 'end'; x0: number; from: [number, number] }
  | { kind: 'clip'; ids: string[]; mode: 'move' | 'start' | 'end'; x0: number; moved: boolean; base: Map<string, Clip> }
  | { kind: 'keys'; keys: KeyRef[]; x0: number; moved: boolean }
  | { kind: 'audio'; g: AudioDrag };

let host: HTMLElement | undefined;
let editor: Editor | undefined;
let lastBody = '';
let lastControls = '';
let lastTicks = '';
let lastProps = '';
let drag: Drag | undefined;
let scrubTarget = -1;
let scrubFrame = 0;

const enabled = (e: Editor, id: string) => {
  const c = commands.get(id);
  return !!c && (!c.enabled || c.enabled(e));
};
const button = (e: Editor, id: string, icon: string, label: string, extra = '', cls = '') =>
  `<button class="icon-button${cls ? ` ${cls}` : ''}" data-command="${id}" title="${escapeXML(label)}" aria-label="${escapeXML(label)}" ${enabled(e, id) ? '' : 'disabled'} ${extra}>${svg(icon, 16)}</button>`;

/** Pixels per frame: the stored zoom, or the whole timeline fitted to the view. */
function zoomOf(e: Editor, tl: VideoTimeline) {
  const z = videoView(e).zoom;
  if (z > 0) return z;
  const width = (host?.querySelector<HTMLElement>('.vt-body')?.clientWidth ?? 800) - HEAD - 24;
  return Math.max(minZoom, Math.min(maxZoom, width / tl.duration));
}
const zoomToSlider = (z: number) => Math.round((Math.log(z / minZoom) / Math.log(maxZoom / minZoom)) * 1000);
const sliderToZoom = (v: number) => minZoom * Math.pow(maxZoom / minZoom, v / 1000);

/** Track rows in panel order: top layer first, children of open groups after their group. */
function trackLayers(e: Editor, layers: Layer[], depth = 0, out: { l: Layer; depth: number }[] = []) {
  for (const l of [...layers].reverse()) {
    out.push({ l, depth });
    if (l.kind === 'group' && !e.collapsedGroups.has(l.id)) trackLayers(e, l.children, depth + 1, out);
  }
  return out;
}

function transitionText(t: Transition, edge: 'in' | 'out', fps: number) {
  const name = transitionKinds.find(([k]) => k === t.kind)![1];
  const where = t.kind === 'cross-fade' ? 'from the clip before' : edge === 'in' ? 'in' : 'out';
  return `${name} ${where}, ${(t.duration / fps).toFixed(2)} s${t.kind === 'fade-color' ? ` (${t.color ?? '#000000'})` : ''}`;
}

function clipHtml(e: Editor, tl: VideoTimeline, l: Layer, zoom: number) {
  const c = clipOf(tl, l.id);
  const kind = isVideoLayer(l) ? 'video' : l.kind === 'group' ? 'group' : l.kind === 'adjustment' ? 'adjustment' : 'still';
  const left = c.start * zoom,
    width = Math.max(3, c.length * zoom);
  const fade = (t: Transition | undefined, edge: 'in' | 'out') =>
    t ? `<span class="vt-fade ${edge} ${t.kind}" data-transition="${escapeXML(l.id)}" style="width:${Math.min(width, t.duration * zoom)}px${t.kind === 'fade-color' ? `;--fade-color:${t.color ?? '#000000'}` : ''}" title="${escapeXML(transitionText(t, edge, tl.fps))} (click to change)"></span>` : '';
  const marks = (tl.clips[l.id]?.keys ? keyProperties.flatMap((p) => tl.clips[l.id].keys![p]?.map((k) => k.t - c.in + c.start) ?? []) : [])
    .filter((t, i, a) => a.indexOf(t) === i)
    .map((t) => `<span class="vt-mark" style="left:${(t - c.start + 0.5) * zoom}px"></span>`)
    .join('');
  const sel = e.selectedIds.has(l.id);
  const range = `${timecode(c.start, tl.fps)} to ${timecode(clipEnd(c), tl.fps)}`;
  return `<div class="vt-clip ${kind}${sel ? ' selected' : ''}${l.visible ? '' : ' hidden-layer'}" data-clip="${escapeXML(l.id)}" style="left:${left}px;width:${width}px" title="${escapeXML(`${l.name}: ${range}`)}"><span class="vt-trim start" data-trim="start" title="Drag to trim the start"></span>${fade(c.fadeIn, 'in')}<span class="vt-clip-label">${kind === 'video' ? svg('film', 11) : ''}${escapeXML(l.name)}</span>${marks}${fade(c.fadeOut, 'out')}<span class="vt-trim end" data-trim="end" title="Drag to trim the end"></span></div>`;
}

function keyLane(e: Editor, tl: VideoTimeline, l: Layer, prop: KeyProperty, zoom: number) {
  const c = clipOf(tl, l.id);
  const keys = c.keys?.[prop] ?? [];
  const selected = new Set(videoView(e).keys.filter((k) => k.id === l.id && k.prop === prop).map((k) => k.t));
  const on = !!keys.length;
  const here = keys.some((k) => k.t === contentFrame(c, tl.current));
  const name = propNames[prop];
  const arg = `${l.id}|${prop}`;
  const lane = keys
    .map((k) => {
      const t = k.t - c.in + c.start;
      return `<span class="vt-key${k.hold ? ' hold' : ''}${selected.has(k.t) ? ' selected' : ''}" data-key="${escapeXML(`${l.id}|${prop}|${k.t}`)}" style="left:${(t + 0.5) * zoom}px" title="${escapeXML(`${name} keyframe at ${timecode(t, tl.fps)} (${k.hold ? 'hold' : 'linear'})`)}"></span>`;
    })
    .join('');
  return `<div class="vt-row vt-prop-row" data-owner="${escapeXML(l.id)}"><div class="vt-head vt-prop-head">
<button class="icon-button vt-stopwatch" data-command="timeline.animate-${prop}" data-arg="${escapeXML(l.id)}" aria-pressed="${on}" title="${on ? `Stop animating ${name.toLowerCase()} (removes its keyframes)` : `Animate ${name.toLowerCase()}: edits at the playhead add keyframes`}" aria-label="Animate ${name} of ${escapeXML(l.name)}">${svg('stopwatch', 13)}</button>
<span class="vt-prop-name">${name}</span>
<span class="vt-key-nav">
<button class="icon-button" data-key-nav="-1" data-arg="${escapeXML(arg)}" title="Previous ${name.toLowerCase()} keyframe" aria-label="Previous ${name} keyframe" ${on ? '' : 'disabled'}>${svg('chevron-left', 12)}</button>
<button class="icon-button vt-key-toggle${here ? ' on' : ''}" data-command="timeline.toggle-key" data-arg="${escapeXML(arg)}" title="${here ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}" aria-label="${here ? 'Remove' : 'Add'} ${name} keyframe" ${on ? '' : 'disabled'}>${svg('keyframe', 12)}</button>
<button class="icon-button" data-key-nav="1" data-arg="${escapeXML(arg)}" title="Next ${name.toLowerCase()} keyframe" aria-label="Next ${name} keyframe" ${on ? '' : 'disabled'}>${svg('chevron-right', 12)}</button>
</span></div><div class="vt-lane vt-key-lane">${lane}</div></div>`;
}

function bodyHtml(e: Editor, tl: VideoTimeline, zoom: number) {
  const view = videoView(e);
  const [ws, we] = workArea(tl);
  const width = tl.duration * zoom;
  const rows = trackLayers(e, e.doc.layers)
    .map(({ l, depth }) => {
      const open = view.expanded.has(l.id);
      const icon = isVideoLayer(l) ? 'film' : l.kind === 'group' ? 'folder' : l.kind === 'adjustment' ? 'adjustment-layer' : l.kind === 'text' ? 'type' : l.kind === 'vector' ? 'shapes' : 'image';
      const sel = e.selectedIds.has(l.id);
      const head = `<div class="vt-head" data-select="${escapeXML(l.id)}" style="--depth:${depth}"><button class="icon-button vt-disclosure" data-expand="${escapeXML(l.id)}" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} keyframes" aria-label="${open ? 'Hide' : 'Show'} keyframes of ${escapeXML(l.name)}">${svg(open ? 'chevron-down' : 'chevron-right', 12)}</button><span class="vt-icon" aria-hidden="true">${svg(icon, 13)}</span><span class="vt-name" title="${escapeXML(l.name)}">${escapeXML(l.name)}</span>${isVideoLayer(l) && l.video.audio ? `<button class="icon-button vt-track-toggle" data-video-mute="${escapeXML(l.id)}" aria-pressed="${!!l.video.muted}" title="${l.video.muted ? 'Unmute' : 'Mute'} the sound of this video layer" aria-label="Mute the sound of ${escapeXML(l.name)}">${svg(l.video.muted ? 'speaker-off' : 'speaker', 13)}</button>` : ''}</div>`;
      const props = open ? keyProperties.filter((p) => canAnimate(l, p)).map((p) => keyLane(e, tl, l, p, zoom)).join('') : '';
      return `<div class="vt-row vt-track${sel ? ' selected' : ''}" data-row="${escapeXML(l.id)}">${head}<div class="vt-lane" data-lane="${escapeXML(l.id)}">${clipHtml(e, tl, l, zoom)}</div></div>${props}`;
    })
    .join('');
  const empty = rows ? '' : '<p class="vt-empty">Add layers to place them on the timeline.</p>';
  return `<div class="vt-grid" style="width:${HEAD + width + 24}px;--zoom:${zoom}px">
<div class="vt-ruler-row"><div class="vt-corner"><span class="vt-corner-time" title="Current time (minutes:seconds:frames)"></span><span class="vt-corner-fps">${fpsLabel(tl.fps)}</span></div>
<div class="vt-ruler" data-ruler title="Click or drag to move the current time" style="width:${width}px"><div class="vt-ticks"></div>
<div class="vt-out" style="left:${we * zoom}px;width:${Math.max(0, (tl.duration - we) * zoom)}px"></div><div class="vt-out" style="left:0;width:${ws * zoom}px"></div>
<div class="vt-work" style="left:${ws * zoom}px;width:${(we - ws) * zoom}px" title="Work area: ${timecode(ws, tl.fps)} to ${timecode(we, tl.fps)}"><span class="vt-work-handle start" data-work="start" title="Drag to set the start of the work area"></span><span class="vt-work-handle end" data-work="end" title="Drag to set the end of the work area"></span></div>
<span class="vt-knob" aria-hidden="true"></span></div></div>
${rows}${empty}${audioRowsHtml(e, tl, zoom)}<div class="vt-end" style="left:${HEAD + width}px" title="End of the timeline"></div><div class="vt-playhead" aria-hidden="true"></div></div>`;
}

function controlsHtml(e: Editor, tl: VideoTimeline, zoom: number) {
  const playing = isVideoPlaying(e);
  const loop = videoView(e).loop;
  const rates = frameRates.includes(tl.fps) ? frameRates : [...frameRates, tl.fps].sort((a, b) => a - b);
  return `${button(e, 'animation.first', 'chevron-first', 'Go to the start of the work area')}${button(e, 'animation.previous', 'step-back', 'Previous frame (Left arrow)')}
${button(e, 'animation.play', playing ? 'pause' : 'play', playing ? 'Stop (Space)' : 'Play (Space)', `aria-pressed="${playing}"`, 'timeline-play')}
${button(e, 'animation.next', 'step-forward', 'Next frame (Right arrow)')}${button(e, 'animation.last', 'chevron-last', 'Go to the end of the work area')}
${button(e, 'timeline.loop', 'repeat', loop ? 'Loop playback (on)' : 'Loop playback (off)', `aria-pressed="${loop}"`)}
<span class="timeline-sep"></span>
<span class="vt-time" title="Current time / duration (minutes:seconds:frames)" aria-live="off"></span>
<select class="vt-fps" title="Frame rate of the timeline" aria-label="Frame rate">${rates.map((r) => `<option value="${r}" ${r === tl.fps ? 'selected' : ''}>${escapeXML(fpsLabel(r))}</option>`).join('')}</select>
<span class="timeline-sep"></span>
${button(e, 'timeline.split', 'split-clip', 'Split the selected clips at the playhead')}${button(e, 'timeline.transitions', 'transition', 'Transitions of the selected clip…')}
${button(e, 'layer.video-new-file', 'image-plus', 'New video layer from a file…')}
${button(e, 'animation.onion', 'onion-skin', 'Onion skins', `aria-pressed="${!!tl.onion?.enabled}"`)}
<span class="timeline-spacer"></span>
<button class="icon-button" data-zoom="out" title="Zoom out" aria-label="Zoom out">${svg('zoom-out', 15)}</button>
<input class="vt-zoom" type="range" min="0" max="1000" step="1" value="${zoomToSlider(zoom)}" title="Timeline zoom" aria-label="Timeline zoom">
<button class="icon-button" data-zoom="in" title="Zoom in" aria-label="Zoom in">${svg('zoom-in', 15)}</button>
<button class="icon-button" data-zoom="fit" title="Fit the whole timeline" aria-label="Fit the whole timeline" aria-pressed="${videoView(e).zoom === 0}">${svg('move-horizontal', 15)}</button>
<span class="timeline-sep"></span>
${button(e, 'timeline.settings', 'settings', 'Timeline settings (duration and frame rate)…')}${button(e, 'file.render-video', 'clapperboard', 'Render video…')}`;
}

/** Ruler ticks for the visible part of the timeline. */
function renderTicks(e: Editor) {
  const tl = timelineOf(e);
  const body = host?.querySelector<HTMLElement>('.vt-body');
  const ticks = host?.querySelector<HTMLElement>('.vt-ticks');
  if (!tl || !body || !ticks) return;
  const zoom = zoomOf(e, tl);
  const step = rulerStep(tl.fps, zoom);
  const minor = Math.max(1, step / 5) * zoom >= 6 ? Math.max(1, Math.round(step / 5)) : step;
  const from = Math.max(0, Math.floor((body.scrollLeft - HEAD) / zoom / step) * step);
  const to = Math.min(tl.duration, Math.ceil((body.scrollLeft + body.clientWidth) / zoom / step + 1) * step);
  const out: string[] = [];
  for (let f = from - (from % minor); f <= to; f += minor) {
    if (f % step === 0) out.push(`<span class="vt-tick major" style="left:${f * zoom}px"><span>${timecode(f, tl.fps)}</span></span>`);
    else out.push(`<span class="vt-tick" style="left:${f * zoom}px"></span>`);
  }
  const html = out.join('');
  if (html !== lastTicks || !ticks.firstChild) ticks.innerHTML = lastTicks = html;
}

/** Move the current-time indicator (also while playing or scrubbing). */
function placePlayhead(e: Editor, frame?: number) {
  const tl = timelineOf(e);
  if (!tl || !host) return;
  const zoom = zoomOf(e, tl);
  const f = frame ?? (isVideoPlaying(e) ? videoPlayback.frame : tl.current);
  const x = (f + 0.5) * zoom;
  host.querySelector<HTMLElement>('.vt-playhead')?.style.setProperty('left', `${HEAD + x}px`);
  host.querySelector<HTMLElement>('.vt-knob')?.style.setProperty('left', `${x}px`);
  const time = timecode(f, tl.fps);
  const corner = host.querySelector('.vt-corner-time');
  if (corner) corner.textContent = time;
  const label = host.querySelector('.vt-time');
  if (label) label.textContent = `${time} / ${timecode(tl.duration, tl.fps)}`;
}

/** Scroll so the playhead stays visible while playing. */
function follow(e: Editor) {
  const tl = timelineOf(e);
  const body = host?.querySelector<HTMLElement>('.vt-body');
  if (!tl || !body) return;
  const x = HEAD + (videoPlayback.frame + 0.5) * zoomOf(e, tl);
  if (x < body.scrollLeft + HEAD || x > body.scrollLeft + body.clientWidth - 20) body.scrollLeft = x - HEAD - 20;
}

export function renderVideoTimeline(e: Editor, el: HTMLElement) {
  editor = e;
  if (host !== el) mount(e, el);
  const tl = timelineOf(e);
  if (!tl) return;
  const zoom = zoomOf(e, tl);
  const body = el.querySelector<HTMLElement>('.vt-body')!;
  const controls = el.querySelector<HTMLElement>('.vt-controls')!;
  // Keep only selected keyframes that still exist.
  const view = videoView(e);
  view.keys = view.keys.filter((k) => tl.clips[k.id]?.keys?.[k.prop]?.some((x) => x.t === k.t));
  if (!drag) {
    const html = bodyHtml(e, tl, zoom);
    if (html !== lastBody) {
      const { scrollLeft, scrollTop } = body;
      body.innerHTML = lastBody = html;
      body.scrollLeft = scrollLeft;
      body.scrollTop = scrollTop;
      lastTicks = '';
    }
  }
  const ctl = controlsHtml(e, tl, zoom);
  if (ctl !== lastControls) {
    const focused = controls.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : '';
    controls.innerHTML = lastControls = ctl;
    if (focused) controls.querySelector<HTMLElement>(`.${focused.split(' ').join('.')}`)?.focus();
  }
  const bar = el.querySelector<HTMLElement>('.vt-audio-props')!;
  const props = audioPropsHtml(e, tl);
  // Keep the bar while one of its fields has focus (typing a value).
  if (props !== lastProps && !(bar.contains(document.activeElement) && document.activeElement?.matches('input'))) {
    bar.innerHTML = lastProps = props;
    bar.hidden = !props;
  }
  renderTicks(e);
  placePlayhead(e, drag?.kind === 'scrub' ? scrubFrame : undefined);
}

function frameAt(e: Editor, clientX: number) {
  const tl = timelineOf(e)!;
  const grid = host!.querySelector<HTMLElement>('.vt-grid')!;
  const x = clientX - grid.getBoundingClientRect().left - HEAD;
  return Math.max(0, Math.min(tl.duration - 1, Math.floor(x / zoomOf(e, tl))));
}

function setZoom(e: Editor, zoom: number, anchorClientX?: number) {
  const tl = timelineOf(e);
  const body = host?.querySelector<HTMLElement>('.vt-body');
  if (!tl || !body) return;
  const old = zoomOf(e, tl);
  const z = Math.max(minZoom, Math.min(maxZoom, zoom));
  // Keep the frame under the pointer (or the playhead) in place.
  const r = body.getBoundingClientRect();
  const px = anchorClientX !== undefined ? anchorClientX - r.left : HEAD + (tl.current + 0.5) * old - body.scrollLeft;
  const frame = (body.scrollLeft + px - HEAD) / old;
  videoView(e).zoom = z;
  lastBody = '';
  renderVideoTimeline(e, host!);
  body.scrollLeft = Math.max(0, frame * z + HEAD - px);
  renderTicks(e);
}

function mount(e: Editor, el: HTMLElement) {
  host = el;
  el.classList.add('vt');
  el.innerHTML = `<div class="vt-body" tabindex="0" aria-label="Video timeline: tracks, clips, keyframes and audio"></div><div class="vt-audio-props" role="group" aria-label="Audio properties" hidden></div><div class="timeline-controls vt-controls" role="toolbar" aria-label="Timeline controls"></div>`;
  lastBody = lastControls = lastTicks = lastProps = '';
  const body = el.querySelector<HTMLElement>('.vt-body')!;
  const controls = el.querySelector<HTMLElement>('.vt-controls')!;
  const bar = el.querySelector<HTMLElement>('.vt-audio-props')!;
  // Waveforms draw once their sound is decoded.
  let decodedFrame = 0;
  onAudioDecoded(() => {
    if (decodedFrame) return;
    decodedFrame = requestAnimationFrame(() => {
      decodedFrame = 0;
      if (editor && host?.isConnected && timelineOf(editor) && !drag) {
        lastBody = '';
        renderVideoTimeline(editor, host);
      }
    });
  });
  bar.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    const out = t.parentElement?.querySelector('output');
    if (out && t.type === 'range') out.textContent = `${Number(t.value) > 0 ? '+' : Number(t.value) < 0 ? '−' : ''}${Math.abs(Number(t.value)).toFixed(1)} dB`;
  });
  bar.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const key = t.dataset.audio;
    const ed = editor;
    if (!key || !ed || ed.busy) return;
    const v = Number(t.value);
    if (!Number.isFinite(v)) return;
    void ed.runCommand('timeline.audio-set', t.dataset.track ? { track: t.dataset.track, [key]: v } : { clip: t.dataset.clip, [key]: v });
  });
  // While playing only the indicator moves; the view redraws when playback starts or stops.
  let wasPlaying = false;
  onVideoPlayback(() => {
    const ed = editor;
    if (!ed || !host?.isConnected || !timelineOf(ed)) return;
    const playing = isVideoPlaying(ed);
    if (playing) {
      placePlayhead(ed);
      follow(ed);
    }
    if (playing !== wasPlaying) {
      wasPlaying = playing;
      renderVideoTimeline(ed, host);
    }
  });
  body.addEventListener('scroll', () => editor && renderTicks(editor), { passive: true });
  new ResizeObserver(() => {
    if (editor && host?.isConnected && timelineOf(editor) && !videoView(editor).zoom) {
      lastBody = '';
      renderVideoTimeline(editor, host);
    }
  }).observe(body);

  controls.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.classList.contains('vt-fps')) void e.runCommand('timeline.frame-rate', Number((t as HTMLSelectElement).value));
  });
  controls.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.classList.contains('vt-zoom') && editor) setZoom(editor, sliderToZoom(Number(t.value)));
  });
  controls.addEventListener('click', (ev) => {
    const z = (ev.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (!z || !editor) return;
    const tl = timelineOf(editor)!;
    if (z.dataset.zoom === 'fit') {
      videoView(editor).zoom = 0;
      lastBody = '';
      renderVideoTimeline(editor, host!);
      return;
    }
    setZoom(editor, zoomOf(editor, tl) * (z.dataset.zoom === 'in' ? 1.5 : 1 / 1.5));
  });

  body.addEventListener('wheel', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !editor) return;
    ev.preventDefault();
    setZoom(editor, zoomOf(editor, timelineOf(editor)!) * Math.exp(-ev.deltaY * 0.004), ev.clientX);
  }, { passive: false });

  body.addEventListener('click', (ev) => {
    const ed = editor;
    if (!ed) return;
    const t = ev.target as HTMLElement;
    const expand = t.closest<HTMLElement>('[data-expand]');
    if (expand) {
      const set = videoView(ed).expanded;
      const id = expand.dataset.expand!;
      if (set.has(id)) set.delete(id);
      else set.add(id);
      renderVideoTimeline(ed, host!);
      return;
    }
    const nav = t.closest<HTMLElement>('[data-key-nav]');
    if (nav) {
      const [id, prop] = nav.dataset.arg!.split('|');
      void cmd.gotoKey(ed, Number(nav.dataset.keyNav) as 1 | -1, { id, prop: prop as KeyProperty });
      return;
    }
    const mute = t.closest<HTMLElement>('[data-video-mute]');
    if (mute && !ed.busy) {
      videoView(ed).audioClips = [];
      ed.selectLayers([mute.dataset.videoMute!]);
      void ed.runCommand('layer.video-mute');
      return;
    }
    const tr = t.closest<HTMLElement>('[data-transition]');
    if (tr && !ed.busy) {
      ed.selectLayers([tr.dataset.transition!]);
      void ed.runCommand('timeline.transitions');
      return;
    }
    const head = t.closest<HTMLElement>('[data-select]');
    if (head && !t.closest('button')) {
      videoView(ed).audioClips = [];
      ed.selectLayer(head.dataset.select!, ev.metaKey || ev.ctrlKey, ev.shiftKey);
    }
    const audioHead = t.closest<HTMLElement>('[data-audio-track]');
    if (audioHead && !t.closest('button')) {
      const view = videoView(ed);
      view.audioTrack = audioHead.dataset.audioTrack!;
      view.audioClips = [];
      ed.update();
    }
  });

  body.addEventListener('dblclick', (ev) => {
    const ed = editor;
    const t = ev.target as HTMLElement;
    if (!ed || ed.busy || t.closest('button')) return;
    const audioHead = t.closest<HTMLElement>('[data-audio-track]');
    if (audioHead) void ed.runCommand('timeline.audio-track-rename', audioHead.dataset.audioTrack);
    else if (t.closest('[data-audio-clip]') && !t.closest('[data-trim],[data-afade]')) void ed.runCommand('timeline.audio-settings');
  });

  body.addEventListener('contextmenu', (ev) => {
    const ed = editor;
    if (!ed) return;
    const t = ev.target as HTMLElement;
    const key = t.closest<HTMLElement>('[data-key]');
    const clip = t.closest<HTMLElement>('[data-clip]');
    const audioClip = t.closest<HTMLElement>('[data-audio-clip]');
    const audioHead = t.closest<HTMLElement>('[data-audio-track]');
    if (audioClip || audioHead) {
      ev.preventDefault();
      const view = videoView(ed);
      if (audioClip) {
        const id = audioClip.dataset.audioClip!;
        if (!view.audioClips.includes(id)) view.audioClips = [id];
        view.audioTrack = audioClip.closest<HTMLElement>('[data-audio-lane]')?.dataset.audioLane ?? view.audioTrack;
      } else {
        view.audioTrack = audioHead!.dataset.audioTrack!;
        view.audioClips = [];
      }
      ed.update();
      showContextMenu(ed, ev.clientX, ev.clientY, audioClip ? audioClipMenu() : audioTrackMenu());
      return;
    }
    if (!key && !clip) return;
    ev.preventDefault();
    if (key) {
      const ref = parseKey(key.dataset.key!);
      const view = videoView(ed);
      if (!view.keys.some((k) => sameKey(k, ref))) view.keys = [ref];
      ed.update();
      showContextMenu(ed, ev.clientX, ev.clientY, ['timeline.key-linear', 'timeline.key-hold', '-', 'timeline.delete-keys']);
    } else {
      const id = clip!.dataset.clip!;
      if (!ed.selectedIds.has(id)) ed.selectLayers([id]);
      ed.update();
      showContextMenu(ed, ev.clientX, ev.clientY, ['timeline.split', 'timeline.trim-start', 'timeline.trim-end', '-', 'timeline.transitions', '-', 'timeline.animate-position', 'timeline.animate-opacity', 'timeline.animate-style']);
    }
  });

  body.addEventListener('keydown', (ev) => {
    const ed = editor;
    if (!ed || ed.busy || (ev.target as HTMLElement).closest('input,select')) return;
    const tl = timelineOf(ed);
    if (!tl) return;
    const [ws, we] = workArea(tl);
    const big = ev.shiftKey ? Math.max(1, Math.round(tl.fps)) : 1;
    if (ev.key === 'ArrowLeft') void setTime(ed, tl.current - big);
    else if (ev.key === 'ArrowRight') void setTime(ed, tl.current + big);
    else if (ev.key === 'Home') void setTime(ed, ws);
    else if (ev.key === 'End') void setTime(ed, we - 1);
    else if (ev.key === ' ') void ed.runCommand('animation.play');
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && videoView(ed).keys.length) void ed.runCommand('timeline.delete-keys');
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && videoView(ed).audioClips.length) void ed.runCommand('timeline.audio-delete');
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  body.addEventListener('pointerdown', (ev) => {
    const ed = editor;
    if (!ed || ev.button !== 0 || ed.busy) return;
    const tl = timelineOf(ed);
    if (!tl) return;
    const t = ev.target as HTMLElement;
    if (t.closest('button,input,select')) return;
    const work = t.closest<HTMLElement>('[data-work]');
    const key = t.closest<HTMLElement>('[data-key]');
    const clip = t.closest<HTMLElement>('[data-clip]');
    const ruler = t.closest('[data-ruler],.vt-corner');
    const lane = t.closest<HTMLElement>('[data-lane]');
    const audioClip = t.closest<HTMLElement>('[data-audio-clip]');
    const audioLane = t.closest<HTMLElement>('[data-audio-lane]');
    if (isVideoPlaying(ed)) void ed.runCommand('animation.play');
    if (audioClip) {
      const g = beginAudioDrag(ed, ev, t);
      if (!g) return;
      drag = { kind: 'audio', g };
      ed.update();
    } else if (audioLane) {
      const view = videoView(ed);
      view.audioTrack = audioLane.dataset.audioLane!;
      view.audioClips = [];
      view.keys = [];
      drag = { kind: 'scrub' };
      ed.update();
      scrub(ed, frameAt(ed, ev.clientX));
    } else if (work) {
      drag = { kind: 'work', edge: work.dataset.work as 'start' | 'end', x0: ev.clientX, from: workArea(tl) };
    } else if (key) {
      const ref = parseKey(key.dataset.key!);
      const view = videoView(ed);
      const has = view.keys.some((k) => sameKey(k, ref));
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) view.keys = has ? view.keys.filter((k) => !sameKey(k, ref)) : [...view.keys, ref];
      else if (!has) view.keys = [ref];
      drag = { kind: 'keys', keys: view.keys.some((k) => sameKey(k, ref)) ? view.keys : [ref], x0: ev.clientX, moved: false };
      lastBody = '';
      renderVideoTimeline(ed, host!);
    } else if (clip) {
      videoView(ed).audioClips = [];
      const id = clip.dataset.clip!;
      const trim = t.closest<HTMLElement>('[data-trim]')?.dataset.trim as 'start' | 'end' | undefined;
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) ed.selectLayer(id, true, false);
      else if (!ed.selectedIds.has(id)) ed.selectLayer(id);
      videoView(ed).keys = [];
      const ids = trim ? [id] : [...ed.selectedIds].filter((x) => body.querySelector(`[data-clip="${CSS.escape(x)}"]`));
      drag = { kind: 'clip', ids: ids.length ? ids : [id], mode: trim ?? 'move', x0: ev.clientX, moved: false, base: new Map(ids.map((x) => [x, clipOf(tl, x)])) };
    } else if (ruler || lane) {
      if (lane && !ruler) {
        videoView(ed).audioClips = [];
        ed.selectLayer(lane.dataset.lane!, ev.metaKey || ev.ctrlKey, ev.shiftKey);
        videoView(ed).keys = [];
      }
      drag = { kind: 'scrub' };
      scrub(ed, frameAt(ed, ev.clientX));
    } else return;
    body.setPointerCapture(ev.pointerId);
    body.focus({ preventScroll: true });
    ev.preventDefault();
  });

  body.addEventListener('pointermove', (ev) => {
    const ed = editor;
    if (!ed || !drag) return;
    const tl = timelineOf(ed);
    if (!tl) return;
    const zoom = zoomOf(ed, tl);
    if (drag.kind === 'scrub') scrub(ed, frameAt(ed, ev.clientX));
    else if (drag.kind === 'audio') moveAudioDrag(ed, drag.g, ev, host!, zoom);
    else if (drag.kind === 'work') {
      const f = frameAt(ed, ev.clientX);
      const [a, b] = drag.from;
      const next: [number, number] = drag.edge === 'start' ? [Math.min(f, b - 1), b] : [a, Math.max(a + 1, f + 1)];
      const w = host!.querySelector<HTMLElement>('.vt-work')!;
      w.style.left = `${next[0] * zoom}px`;
      w.style.width = `${(next[1] - next[0]) * zoom}px`;
      w.dataset.range = next.join(',');
      w.title = `Work area: ${timecode(next[0], tl.fps)} to ${timecode(next[1], tl.fps)}`;
    } else if (drag.kind === 'clip') {
      const d = Math.round((ev.clientX - drag.x0) / zoom);
      if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
      if (!drag.moved) return;
      for (const id of drag.ids) {
        const el = host!.querySelector<HTMLElement>(`[data-clip="${CSS.escape(id)}"]`);
        const l = ed.doc.layers && findById(ed, id);
        if (!el || !l) continue;
        const c = previewClip(drag.mode, drag.base.get(id)!, d, l, tl);
        el.style.left = `${c.start * zoom}px`;
        el.style.width = `${Math.max(3, c.length * zoom)}px`;
        if (id === drag.ids[0]) showReadout(ed, `${timecode(c.start, tl.fps)} to ${timecode(clipEnd(c), tl.fps)}`);
      }
    } else if (drag.kind === 'keys') {
      const d = Math.round((ev.clientX - drag.x0) / zoom);
      if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
      if (!drag.moved) return;
      for (const k of drag.keys) {
        const el = host!.querySelector<HTMLElement>(`[data-key="${CSS.escape(`${k.id}|${k.prop}|${k.t}`)}"]`);
        const c = clipOf(tl, k.id);
        if (el) el.style.left = `${(k.t + d - c.in + c.start + 0.5) * zoom}px`;
      }
    }
  });

  const end = (ev: PointerEvent) => {
    const ed = editor;
    const g = drag;
    drag = undefined;
    if (!ed || !g) return;
    const tl = timelineOf(ed);
    if (!tl) return;
    if (body.hasPointerCapture(ev.pointerId)) body.releasePointerCapture(ev.pointerId);
    const zoom = zoomOf(ed, tl);
    if (g.kind === 'audio') {
      void endAudioDrag(ed, g.g, ev, host!).finally(() => {
        lastBody = '';
        if (host) renderVideoTimeline(ed, host);
      });
      return;
    }
    if (g.kind === 'scrub') {
      if (scrubTarget >= 0) void setTime(ed, scrubTarget);
      scrubTarget = -1;
      lastBody = '';
      renderVideoTimeline(ed, host!);
    } else if (g.kind === 'work') {
      const w = host!.querySelector<HTMLElement>('.vt-work');
      const range = w?.dataset.range?.split(',').map(Number) as [number, number] | undefined;
      if (range && ev.type === 'pointerup') {
        void cmd.changeWork(ed, range);
      } else {
        lastBody = '';
        renderVideoTimeline(ed, host!);
      }
    } else if (g.kind === 'clip') {
      const d = Math.round((ev.clientX - g.x0) / zoom);
      if (!g.moved || !d || ev.type !== 'pointerup') {
        lastBody = '';
        renderVideoTimeline(ed, host!);
        return;
      }
      const label = g.mode === 'move' ? (g.ids.length > 1 ? 'Move Clips' : 'Move Clip') : 'Trim Clip';
      void cmd.changeClips(ed, g.ids, label, (c, l, t) => previewClip(g.mode, c, d, l, t)).then(() => {
        lastBody = '';
        renderVideoTimeline(ed, host!);
      });
    } else if (g.kind === 'keys') {
      const d = Math.round((ev.clientX - g.x0) / zoom);
      if (!g.moved || !d || ev.type !== 'pointerup') {
        if (!g.moved && g.keys.length === 1) {
          // A click on a keyframe moves the playhead to it.
          const c = clipOf(tl, g.keys[0].id);
          void setTime(ed, g.keys[0].t - c.in + c.start);
        }
        lastBody = '';
        renderVideoTimeline(ed, host!);
        return;
      }
      void cmd.moveKeys(ed, g.keys, d);
    }
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
}

const findById = (e: Editor, id: string): Layer | undefined => {
  const walk = (layers: Layer[]): Layer | undefined => {
    for (const l of layers) {
      if (l.id === id) return l;
      const c = walk(l.children);
      if (c) return c;
    }
    return undefined;
  };
  return walk(e.doc.layers);
};
function previewClip(mode: 'move' | 'start' | 'end', c: Clip, d: number, l: Layer, tl: VideoTimeline): Clip {
  const limit = contentLength(l, tl.fps);
  return mode === 'move' ? moveClip(c, d, tl.duration) : mode === 'start' ? trimClipStart(c, d, limit) : trimClipEnd(c, d, limit);
}
function showReadout(e: Editor, text: string) {
  const label = host?.querySelector('.vt-time');
  if (label) label.textContent = text;
  void e;
}
function scrub(e: Editor, f: number) {
  scrubFrame = f;
  placePlayhead(e, f);
  if (scrubTarget === f) return;
  scrubTarget = f;
  const tl = timelineOf(e);
  if (tl && videoView(e).scrubAudio) scrubAudio(e.session, e.doc, f / tl.fps);
  void setTime(e, f);
}
const parseKey = (s: string): KeyRef => {
  const [id, prop, t] = s.split('|');
  return { id, prop: prop as KeyProperty, t: Number(t) };
};
const sameKey = (a: KeyRef, b: KeyRef) => a.id === b.id && a.prop === b.prop && a.t === b.t;
