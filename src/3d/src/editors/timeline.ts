// Timeline editor: playback controls, frame range, scrubbing, keyframe summary, markers.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { numberField, enumMenu } from '../ui/widgets';
import { openMenu, openPopover } from '../ui/menu';
import { keyframeFrames } from '../anim/keyframes';

export class FrameView {
  /** frames visible: start & pixels per frame */
  start = -10;
  ppf = 6;
  fit(width: number, a: number, b: number) {
    const span = Math.max(1, b - a);
    this.ppf = (width - 40) / (span + 20);
    this.start = a - 10;
  }
  x(frame: number) {
    return (frame - this.start) * this.ppf;
  }
  frame(x: number) {
    return x / this.ppf + this.start;
  }
  /** label step in frames adapting to zoom */
  step() {
    // steps follow the frame rate (divisors, then multiples of fps)
    const target = 50 / this.ppf;
    const fps = Math.max(1, Math.round(app.doc.scene.render.fps));
    const steps = [1, 2];
    for (let d = 3; d < fps; d++) if (fps % d === 0) steps.push(d);
    for (const k of [1, 2, 4, 5, 10, 20, 50, 100, 200, 500, 1000]) steps.push(fps * k);
    return steps.find((st) => st >= target) ?? fps * 2000;
  }
}

export class Timeline implements Editor {
  el: HTMLElement;
  keymaps = ['Timeline', 'Frames', 'Window', 'Screen'];
  headerBottom = false;
  view = new FrameView();
  private canvas: HTMLCanvasElement;
  private fitted = false;
  onlySelected = true;

  constructor(public area: Area) {
    this.el = document.createElement('div');
    this.el.className = 'timeline';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-canvas';
    this.el.append(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu([{ label: 'Add Marker', op: 'screen.marker_add', shortcut: 'M' }, { label: 'Delete Markers', op: 'screen.marker_delete' }, { separator: true }, { label: 'Insert Keyframe', op: 'anim.keyframe_insert' }], { x: e.clientX, y: e.clientY });
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  header(): Child {
    const s = app.doc.scene;
    const ts = s.tool_settings;
    const playing = app.playing;
    return h(
      'div',
      { class: 'hdr-row' },
      h('button', { class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu([{ label: 'Frame All', action: () => ((this.fitted = false), this.draw()) }, { label: 'Go to Current Frame', action: () => this.center() }, { separator: true }, { label: 'Only Show Selected', checked: this.onlySelected, action: () => ((this.onlySelected = !this.onlySelected), this.draw()) }], e.currentTarget as HTMLElement)) }, 'View'),
      h('button', { class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu([{ label: 'Add Marker', op: 'screen.marker_add' }, { label: 'Delete Marker', op: 'screen.marker_delete' }], e.currentTarget as HTMLElement)) }, 'Marker'),
      h(
        'button',
        {
          class: 'hdr-menu',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openPopover(e.currentTarget as HTMLElement, () =>
              h(
                'div',
                { class: 'pop-panel' },
                h('div', { class: 'pop-title' }, 'Playback'),
                enumMenu('sync', [{ value: 'NONE', label: 'Play Every Frame' }, { value: 'FRAME_DROP', label: 'Frame Dropping' }, { value: 'AUDIO_SYNC', label: 'Sync to Audio' }], s.sync_mode, (v) => ((s.sync_mode = v as 'NONE'), app.pushUndo('Sync Mode'), app.changed('ui'))),
              ),
            );
          },
        },
        'Playback',
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('div', { class: 'hdr-spacer' }),
      h('button', { class: { 'hdr-toggle': true, on: ts.use_keyframe_insert_auto, rec: true }, 'data-tip': 'Auto Keying\nAutomatic keyframe insertion for objects, bones and masks', onclick: () => ((ts.use_keyframe_insert_auto = !ts.use_keyframe_insert_auto), app.pushUndo('Auto Keying'), app.changed('ui')) }, icon('rec')),
      h(
        'div',
        { class: 'hdr-group play' },
        h('button', { class: 'hdr-toggle', 'data-tip': 'Jump to Endpoint\nJump to first frame (Shift ←)', onclick: () => app.run('screen.frame_jump', { end: false }) }, icon('rew')),
        h('button', { class: 'hdr-toggle', 'data-tip': 'Jump to Keyframe\nPrevious keyframe (↓)', onclick: () => app.run('screen.keyframe_jump', { next: false }) }, icon('prev_keyframe')),
        h('button', { class: { 'hdr-toggle': true, on: playing === 'reverse' }, 'data-tip': 'Play Animation in Reverse', onclick: () => app.run('screen.animation_play', { reverse: true }) }, icon(playing === 'reverse' ? 'pause' : 'play_reverse')),
        h('button', { class: { 'hdr-toggle': true, on: playing === 'forward' }, 'data-tip': 'Play Animation (Space)', onclick: () => app.run('screen.animation_play') }, icon(playing === 'forward' ? 'pause' : 'play')),
        h('button', { class: 'hdr-toggle', 'data-tip': 'Jump to Keyframe\nNext keyframe (↑)', onclick: () => app.run('screen.keyframe_jump', { next: true }) }, icon('next_keyframe')),
        h('button', { class: 'hdr-toggle', 'data-tip': 'Jump to Endpoint\nJump to last frame (Shift →)', onclick: () => app.run('screen.frame_jump', { end: true }) }, icon('ff')),
      ),
      h('div', { class: 'hdr-spacer' }),
      h('div', { class: 'tl-frame' }, numberField({ id: 'tl-cur', value: s.frame_current, int: true, unit: 'frame', set: (v) => app.setFrame(v) })),
      h('button', { class: { 'hdr-toggle': true, on: !!s.use_preview_range }, 'data-tip': 'Use Preview Range', onclick: () => ((s.use_preview_range = !s.use_preview_range), s.frame_preview_start ??= s.frame_start, s.frame_preview_end ??= s.frame_end, app.pushUndo('Preview Range'), app.changed('ui')) }, icon('time')),
      h(
        'div',
        { class: 'tl-range' },
        numberField({ id: 'tl-start', label: 'Start', value: s.use_preview_range ? s.frame_preview_start ?? s.frame_start : s.frame_start, int: true, set: (v, f) => (s.use_preview_range ? (s.frame_preview_start = v) : (s.frame_start = v), app.changed('doc'), f && app.pushUndo('Frame Start')) }),
        numberField({ id: 'tl-end', label: 'End', value: s.use_preview_range ? s.frame_preview_end ?? s.frame_end : s.frame_end, int: true, set: (v, f) => (s.use_preview_range ? (s.frame_preview_end = v) : (s.frame_end = v), app.changed('doc'), f && app.pushUndo('Frame End')) }),
      ),
    );
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    this.draw();
  }

  center() {
    const w = this.canvas.clientWidth;
    this.view.start = app.doc.scene.frame_current - w / 2 / this.view.ppf;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const s = app.doc.scene;
    if (!this.fitted) {
      this.view.fit(W, s.frame_start, s.frame_end);
      this.fitted = true;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#303030';
    g.fillRect(0, 0, W, H);
    const v = this.view;
    // out-of-range shading
    const [a, b] = s.use_preview_range ? [s.frame_preview_start ?? s.frame_start, s.frame_preview_end ?? s.frame_end] : [s.frame_start, s.frame_end];
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, 0, v.x(a), H);
    g.fillRect(v.x(b), 0, W - v.x(b), H);
    if (s.use_preview_range) {
      g.fillStyle = 'rgba(220,80,20,0.08)';
      g.fillRect(v.x(a), 0, v.x(b) - v.x(a), H);
    }
    // grid
    const step = v.step();
    const first = Math.floor(v.frame(0) / step) * step;
    g.font = '11px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    for (let f = first; v.x(f) < W + 50; f += step) {
      const x = Math.round(v.x(f)) + 0.5;
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.beginPath();
      g.moveTo(x, 22);
      g.lineTo(x, H);
      g.stroke();
      g.fillStyle = '#9a9a9a';
      g.fillText(String(f), x, 15);
    }
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(0, 0, W, 22);
    // keyframes summary
    const obs = this.onlySelected ? app.selectedObjects() : Object.values(app.doc.objects);
    const frames = keyframeFrames(app.doc, obs);
    const ky = Math.min(H - 12, 22 + (H - 22) / 2);
    for (const [f, sel] of frames) {
      const x = v.x(f);
      if (x < -10 || x > W + 10) continue;
      g.fillStyle = sel ? '#ffbe33' : '#e1e1e1';
      g.strokeStyle = '#000';
      g.beginPath();
      g.moveTo(x, ky - 5);
      g.lineTo(x + 5, ky);
      g.lineTo(x, ky + 5);
      g.lineTo(x - 5, ky);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // markers
    for (const m of s.timeline_markers) {
      const x = v.x(m.frame);
      g.fillStyle = m.select ? '#fff' : '#bbb';
      g.beginPath();
      g.moveTo(x, H - 14);
      g.lineTo(x + 5, H - 8);
      g.lineTo(x - 5, H - 8);
      g.closePath();
      g.fill();
      g.textAlign = 'left';
      g.fillText(m.name, x + 8, H - 6);
      g.textAlign = 'center';
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x + 0.5, 22);
      g.lineTo(x + 0.5, H - 16);
      g.stroke();
      g.setLineDash([]);
    }
    // playhead
    const px = Math.round(v.x(s.frame_current)) + 0.5;
    g.strokeStyle = '#4772b3';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, 22);
    g.lineTo(px, H);
    g.stroke();
    g.lineWidth = 1;
    const label = String(s.frame_current);
    const tw = Math.max(26, g.measureText(label).width + 12);
    g.fillStyle = '#4772b3';
    roundRect(g, px - tw / 2, 3, tw, 18, 4);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(label, px, 16);
  }

  private onDown(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      let last = e.clientX;
      const move = (ev: PointerEvent) => {
        this.view.start -= (ev.clientX - last) / this.view.ppf;
        last = ev.clientX;
        this.draw();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    // markers near the bottom
    if (e.clientY - r.top > r.height - 16) {
      const f = this.view.frame(e.clientX - r.left);
      const m = app.doc.scene.timeline_markers.find((k) => Math.abs(k.frame - f) * this.view.ppf < 6);
      if (m) {
        if (!e.shiftKey) app.doc.scene.timeline_markers.forEach((k) => (k.select = false));
        m.select = !m.select || !e.shiftKey;
        app.changed('ui');
        this.draw();
        return;
      }
    }
    const scrub = (ev: PointerEvent) => {
      const f = Math.round(this.view.frame(ev.clientX - r.left));
      if (f !== app.doc.scene.frame_current) app.setFrame(f);
    };
    scrub(e);
    const up = () => {
      removeEventListener('pointermove', scrub);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', scrub);
    addEventListener('pointerup', up);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      this.view.start += (e.deltaX || e.deltaY) / this.view.ppf;
    } else {
      const f = this.view.frame(e.clientX - r.left);
      const k = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      this.view.ppf = Math.max(0.05, Math.min(200, this.view.ppf * k));
      this.view.start = f - (e.clientX - r.left) / this.view.ppf;
    }
    this.draw();
  }

  onKey(e: KeyboardEvent) {
    if (e.code === 'Home') {
      this.fitted = false;
      this.draw();
      return true;
    }
    if (e.code === 'KeyM' && !e.ctrlKey) {
      app.run('screen.marker_add');
      return true;
    }
    return false;
  }

  dispose() {}
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

registerEditor({ id: 'TIMELINE', label: 'Timeline', icon: 'time_editor', group: 'Animation', create: (a) => new Timeline(a) });

export { patch };
