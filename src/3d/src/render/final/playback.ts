// Render ▸ View Animation (Ctrl F11): plays back the frames of the last animation render in a
// floating player. Frames are kept as the encoded files that were written (or the video).
import { h, patch } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators } from '../../app/app';
import { addKeys } from '../../app/keymap';

interface StoredFrame {
  frame: number;
  blob: Blob;
}

interface Recording {
  fps: number;
  width: number;
  height: number;
  frames: StoredFrame[];
  video: Blob | null;
  bytes: number;
  truncated: boolean;
}

/** Memory kept for playback; later frames are dropped beyond it. */
const MAX_BYTES = 768 * 1024 * 1024;

let recording: Recording | null = null;
let last: Recording | null = null;

export const animationRecorder = {
  begin(fps: number, width: number, height: number) {
    recording = { fps, width, height, frames: [], video: null, bytes: 0, truncated: false };
  },
  addFrame(frame: number, bytes: Uint8Array, mime: string) {
    const r = recording;
    if (!r) return;
    if (r.bytes + bytes.length > MAX_BYTES) {
      r.truncated = true;
      return;
    }
    r.frames.push({ frame, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }) });
    r.bytes += bytes.length;
  },
  setVideo(blob: Blob) {
    if (recording) recording.video = blob;
  },
  finish() {
    if (recording && (recording.frames.length || recording.video)) last = recording;
    recording = null;
  },
  /** Whether an animation render can be played back. */
  available() {
    return !!last;
  },
  /** For tests: drop the stored animation. */
  clear() {
    last = null;
  },
};

// ---------------------------------------------------------------------------
// player window

interface Player {
  el: HTMLElement;
  close(): void;
}

let player: Player | null = null;

export function isPlayerOpen() {
  return !!player;
}

export function closePlayer() {
  player?.close();
}

function openPlayer(rec: Recording) {
  closePlayer();
  const el = document.createElement('div');
  el.className = 'rf-window rf-player';
  const title = document.createElement('div');
  title.className = 'rf-title';
  title.textContent = 'Animation Playback';
  const body = document.createElement('div');
  body.className = 'rf-body rf-player-body';
  const bar = document.createElement('div');
  bar.className = 'area-header rf-player-bar';
  el.append(title, body, bar);
  const maxW = innerWidth * 0.8,
    maxH = innerHeight * 0.8 - 60;
  const s = Math.min(1, maxW / rec.width, maxH / rec.height);
  const W = Math.max(420, Math.round(rec.width * s)),
    H = Math.max(240, Math.round(rec.height * s) + 60);
  Object.assign(el.style, { width: `${W}px`, height: `${H}px`, left: `${Math.round((innerWidth - W) / 2)}px`, top: `${Math.round(Math.max(8, (innerHeight - H) / 2))}px` });
  document.body.append(el);

  let disposed = false;
  let playing = true;
  let index = 0;
  let loop = true;
  const cleanups: (() => void)[] = [];

  // video playback
  if (rec.video) {
    const v = document.createElement('video');
    v.className = 'rf-player-media';
    v.src = URL.createObjectURL(rec.video);
    v.loop = true;
    v.muted = false;
    v.autoplay = true;
    v.playsInline = true;
    body.append(v);
    cleanups.push(() => URL.revokeObjectURL(v.src));
    const draw = () => {
      if (disposed) return;
      const n = Math.max(1, Math.round((v.duration || 0) * rec.fps));
      const cur = Math.min(n - 1, Math.round(v.currentTime * rec.fps));
      patch(bar, [
        h('button', { class: 'hdr-toggle', 'data-tip': v.paused ? 'Play (Space)' : 'Pause (Space)', onclick: () => (v.paused ? void v.play() : v.pause(), draw()) }, icon(v.paused ? 'play' : 'pause')),
        h('input', { type: 'range', class: 'rf-player-scrub', min: 0, max: n - 1, value: cur, oninput: (e: Event) => ((v.currentTime = Number((e.target as HTMLInputElement).value) / rec.fps), draw()) }),
        h('span', { class: 'rf-player-info' }, `${cur + 1} / ${n} · ${rec.fps.toFixed(rec.fps % 1 ? 2 : 0)} fps`),
        h('button', { class: { 'hdr-toggle': true, on: v.loop }, 'data-tip': 'Play back in a loop', onclick: () => ((v.loop = !v.loop), draw()) }, 'Loop'),
        h('button', { class: 'hdr-toggle', 'data-tip': 'Close (Esc)', onclick: () => closePlayer() }, icon('panel_close')),
      ]);
    };
    v.addEventListener('timeupdate', draw);
    v.addEventListener('play', draw);
    v.addEventListener('pause', draw);
    draw();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePlayer();
      } else if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (v.paused) void v.play();
        else v.pause();
      }
    };
    addEventListener('keydown', key, true);
    cleanups.push(() => removeEventListener('keydown', key, true));
  } else {
    const canvas = document.createElement('canvas');
    canvas.className = 'rf-player-media';
    canvas.width = rec.width;
    canvas.height = rec.height;
    body.append(canvas);
    const ctx = canvas.getContext('2d')!;
    const bitmaps = new Map<number, ImageBitmap>();
    const decode = async (i: number) => {
      if (bitmaps.has(i)) return bitmaps.get(i)!;
      const b = await createImageBitmap(rec.frames[i].blob);
      bitmaps.set(i, b);
      return b;
    };
    const show = async (i: number) => {
      const b = await decode(i);
      if (disposed) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
    };
    const n = rec.frames.length;
    const draw = () => {
      if (disposed) return;
      patch(bar, [
        h('button', { class: 'hdr-toggle', 'data-tip': playing ? 'Pause (Space)' : 'Play (Space)', onclick: () => ((playing = !playing), draw()) }, icon(playing ? 'pause' : 'play')),
        h('input', { type: 'range', class: 'rf-player-scrub', min: 0, max: n - 1, value: index, oninput: (e: Event) => ((index = Number((e.target as HTMLInputElement).value)), (playing = false), void show(index), draw()) }),
        h('span', { class: 'rf-player-info' }, `Frame ${rec.frames[index]?.frame ?? ''} · ${index + 1} / ${n} · ${rec.fps.toFixed(rec.fps % 1 ? 2 : 0)} fps${rec.truncated ? ' · partial (memory limit)' : ''}`),
        h('button', { class: { 'hdr-toggle': true, on: loop }, 'data-tip': 'Play back in a loop', onclick: () => ((loop = !loop), draw()) }, 'Loop'),
        h('button', { class: 'hdr-toggle', 'data-tip': 'Close (Esc)', onclick: () => closePlayer() }, icon('panel_close')),
      ]);
    };
    let lastT = performance.now();
    let acc = 0;
    let busy = false;
    const tick = async (t: number) => {
      if (disposed) return;
      requestAnimationFrame(tick);
      const dt = (t - lastT) / 1000;
      lastT = t;
      if (!playing || busy || n < 2) return;
      acc += dt;
      const step = 1 / Math.max(1, rec.fps);
      if (acc < step) return;
      acc = Math.min(acc - step, step);
      let next = index + 1;
      if (next >= n) {
        if (!loop) {
          playing = false;
          draw();
          return;
        }
        next = 0;
      }
      index = next;
      busy = true;
      await show(index);
      busy = false;
      draw();
    };
    void show(0).then(() => draw());
    draw();
    requestAnimationFrame(tick);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePlayer();
      } else if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        playing = !playing;
        draw();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        playing = false;
        index = (index + (e.key === 'ArrowLeft' ? n - 1 : 1)) % n;
        void show(index);
        draw();
      }
    };
    addEventListener('keydown', key, true);
    cleanups.push(() => {
      removeEventListener('keydown', key, true);
      for (const b of bitmaps.values()) b.close();
    });
  }

  // drag by the title bar
  title.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    title.setPointerCapture(e.pointerId);
    const sx = e.clientX - el.offsetLeft,
      sy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.min(innerWidth - 60, Math.max(-el.offsetWidth + 60, ev.clientX - sx))}px`;
      el.style.top = `${Math.min(innerHeight - 30, Math.max(0, ev.clientY - sy))}px`;
    };
    const up = () => {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', up);
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
  });
  title.addEventListener('dblclick', () => el.classList.toggle('maximized'));

  player = {
    el,
    close: () => {
      disposed = true;
      for (const c of cleanups) c();
      el.remove();
      player = null;
    },
  };
}

registerOperators([
  {
    idname: 'render.play_rendered_anim',
    label: 'View Animation',
    description: 'Play back the frames of the last animation render',
    undo: false,
    poll: () => !!last,
    exec: () => {
      if (!last) {
        app.report('WARNING', 'Render an animation first (Ctrl F12)');
        return 'CANCELLED';
      }
      openPlayer(last);
      return 'CANCELLED';
    },
  },
]);

addKeys('Window', [{ key: 'F11', ctrl: true, op: 'render.play_rendered_anim' }]);
