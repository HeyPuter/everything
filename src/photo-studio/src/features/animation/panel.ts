// The Timeline panel: a strip of frame thumbnails with per-frame delays,
// playback and frame controls, or the video timeline view (tracks of clips
// and keyframes on a time ruler) for documents with a video timeline. It
// docks under the canvas.
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import { commands, type MenuItem, type Panel } from '../../app/registry';
import { svg } from '../../app/icons';
import { showContextMenu } from '../../app/menubar';
import { escapeXML } from '../../model/assets';
import { delayLabel, loopLabel, moveFrames, totalDuration } from '../../model/animation';
import { animationOf, selectFrame, selectedFrames, selectionAnchor, setSelectedFrames } from './state';
import { isPlaying, onPlaybackChange, playingIndex, stop } from './playback';
import { clearQueue, frameImage, frameKey, onFrameRendered } from './render';
import { lazy } from '../../app/lazy';
import { timelineOf } from './video-state';

// The video timeline view loads with the first document that has a timeline.
const videoPanel = lazy(() => import('./video-panel'));

const button = (e: Editor, id: string, icon: string, label: string, extra = '', cls = '') => {
  const c = commands.get(id);
  const enabled = !c?.enabled || c.enabled(e);
  return `<button class="icon-button${cls ? ` ${cls}` : ''}" data-command="${id}" title="${escapeXML(label)}" aria-label="${escapeXML(label)}" ${enabled ? '' : 'disabled'} ${extra}>${svg(icon, 16)}</button>`;
};

export function timelinePanel(menu: (e?: Editor) => MenuItem[]): Panel {
  let host: HTMLElement | undefined;
  let editor: Editor | undefined;
  let lastStrip = '';
  let lastControls = '';
  let queuedDoc: PhotoDocument | undefined;
  let pending = 0;
  const refresh = () => {
    if (!host?.isConnected || !editor) return;
    render(editor, host);
  };
  onFrameRendered(() => {
    refresh();
    if (editor && (animationOf(editor)?.onion?.enabled || timelineOf(editor)?.onion?.enabled)) editor.overlay();
  });
  onPlaybackChange(refresh);

  function render(e: Editor, el: HTMLElement) {
    const anim = animationOf(e);
    const strip = el.querySelector<HTMLElement>('.timeline-frames')!;
    const controls = el.querySelector<HTMLElement>('.timeline-controls')!;
    const video = el.querySelector<HTMLElement>('.video-timeline')!;
    const timed = !!timelineOf(e);
    strip.hidden = timed;
    video.hidden = !timed;
    if (timed) {
      controls.hidden = true;
      lastStrip = lastControls = '';
      const view = videoPanel.loaded;
      if (view) view.renderVideoTimeline(e, video);
      else void videoPanel().then(() => refresh());
      return;
    }
    if (!anim) {
      const tip = (id: string, text: string) => `title="${escapeXML(commands.get(id)?.description ?? text)}"`;
      const html = e.hasDocument
        ? `<div class="timeline-empty"><p>Animate this document frame by frame, where each frame keeps its own layer visibility, position, opacity and effects, or over time on a video timeline with clips, keyframes and video layers.</p><div class="timeline-empty-actions"><button class="primary" data-command="animation.create" ${tip('animation.create', '')}>Create Frame Animation</button><button data-command="timeline.create" ${tip('timeline.create', '')}>Create Video Timeline</button>${e.doc.layers.length > 1 ? `<button data-command="animation.frames-from-layers" ${tip('animation.frames-from-layers', '')}>Make Frames From Layers</button>` : ''}<button data-command="layer.video-new-file" ${tip('layer.video-new-file', '')}>New Video Layer…</button><button data-command="file.import-video-frames" ${tip('file.import-video-frames', '')}>Import Video Frames…</button></div></div>`
        : `<div class="timeline-empty"><p>Open or create a document to animate it, or open a video.</p><div class="timeline-empty-actions"><button data-command="layer.video-new-file" ${tip('layer.video-new-file', '')}>Open Video…</button><button data-command="file.import-video-frames" ${tip('file.import-video-frames', '')}>Import Video Frames…</button></div></div>`;
      if (html !== lastStrip) strip.innerHTML = lastStrip = html;
      strip.removeAttribute('role');
      controls.hidden = true;
      lastControls = '';
      return;
    }
    strip.setAttribute('role', 'listbox');
    controls.hidden = false;
    const playing = isPlaying(e);
    const shown = playing ? (playingIndex() ?? anim.current) : anim.current;
    const selected = new Set(selectedFrames(e));
    const doc = e.doc;
    // Queue only the renders this state needs (stale requests are dropped).
    const changedDoc = queuedDoc !== doc;
    if (changedDoc) {
      clearQueue();
      queuedDoc = doc;
    }
    const cells = anim.frames.map((f, i) => {
      const img = frameImage(e, doc, i, frameKey(e, doc, i));
      const sel = playing ? i === shown : selected.has(i);
      const ratio = `${doc.width} / ${doc.height}`;
      return `<div class="frame-cell${i === shown ? ' current' : ''}" role="option" id="frame-${f.id}" aria-selected="${sel}" data-frame="${i}" draggable="true" aria-label="Frame ${i + 1}, ${escapeXML(delayLabel(f.delay))}"><div class="frame-thumb" style="aspect-ratio:${ratio}">${img ? `<img src="${img.url}" alt="" draggable="false">` : '<span class="frame-pending"></span>'}</div><div class="frame-meta"><span class="frame-number">${i + 1}</span><button class="frame-delay" data-delay="${i}" aria-haspopup="menu" title="Frame delay" tabindex="-1">${escapeXML(delayLabel(f.delay))}${svg('chevron-down', 11)}</button></div></div>`;
    });
    const html = cells.join('') + `<button class="frame-add" data-command="animation.new-frame" title="New frame" aria-label="New frame">${svg('plus', 20)}</button>`;
    if (html !== lastStrip) {
      const scroll = strip.scrollLeft;
      strip.innerHTML = lastStrip = html;
      strip.scrollLeft = scroll;
      strip.setAttribute('aria-activedescendant', `frame-${anim.frames[shown]?.id}`);
      strip.querySelector<HTMLElement>('.frame-cell.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // The editor may have queued onions before this panel discarded stale
    // jobs. Request them again now, and keep them on thumbnail-only refreshes.
    if (changedDoc && anim.onion?.enabled) e.overlay();
    const seconds = totalDuration(anim) / 1000;
    const ctl = `<button class="timeline-loop" data-loop aria-haspopup="menu" title="Looping">${svg('repeat', 14)}<span>${escapeXML(loopLabel(anim.loop))}</span>${svg('chevron-down', 11)}</button>
      <span class="timeline-sep"></span>
      ${button(e, 'animation.first', 'chevron-first', 'First frame')}${button(e, 'animation.previous', 'step-back', 'Previous frame')}
      ${button(e, 'animation.play', playing ? 'pause' : 'play', playing ? 'Stop' : 'Play', `aria-pressed="${playing}"`, 'timeline-play')}
      ${button(e, 'animation.next', 'step-forward', 'Next frame')}${button(e, 'animation.last', 'chevron-last', 'Last frame')}
      <span class="timeline-sep"></span>
      ${button(e, 'animation.tween', 'tween', 'Tween…')}${button(e, 'animation.new-frame', 'copy-plus', 'Duplicate selected frames')}${button(e, 'animation.delete-frames', 'trash-2', 'Delete selected frames')}
      <span class="timeline-sep"></span>
      ${button(e, 'animation.reverse', 'arrow-left-right', 'Reverse frames')}${button(e, 'animation.onion', 'onion-skin', 'Onion skins', `aria-pressed="${!!anim.onion?.enabled}"`)}
      <span class="timeline-spacer"></span>
      <span class="timeline-status" aria-live="off">Frame ${shown + 1} of ${anim.frames.length}${selected.size > 1 && !playing ? ` · ${selected.size} selected` : ''} · ${seconds.toFixed(seconds < 10 ? 2 : 1)} s</span>`;
    if (ctl !== lastControls) controls.innerHTML = lastControls = ctl;
  }

  function cellIndex(t: EventTarget | null) {
    const cell = (t as HTMLElement | null)?.closest<HTMLElement>('[data-frame]');
    return cell ? Number(cell.dataset.frame) : -1;
  }

  return {
    id: 'timeline',
    title: 'Timeline',
    icon: 'film',
    location: 'bottom',
    menu: (e) => menu(e),
    mount(e, el) {
      host = el;
      editor = e;
      el.classList.add('timeline');
      el.innerHTML = `<div class="timeline-frames" tabindex="0" aria-label="Animation frames" aria-multiselectable="true" aria-orientation="horizontal"></div><div class="timeline-controls" role="toolbar" aria-label="Animation controls"></div><div class="video-timeline" hidden></div>`;
      const strip = el.querySelector<HTMLElement>('.timeline-frames')!;
      el.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const anim = animationOf(e);
        if (t.closest('[data-loop]')) {
          const r = t.closest('[data-loop]')!.getBoundingClientRect();
          showContextMenu(e, r.left, r.bottom + 2, loopItems());
          return;
        }
        const delay = t.closest<HTMLElement>('[data-delay]');
        if (delay && anim) {
          const i = Number(delay.dataset.delay);
          if (!selectedFrames(e).includes(i)) selectFrame(e, i);
          const r = delay.getBoundingClientRect();
          showContextMenu(e, r.left, r.bottom + 2, delayItems());
          return;
        }
        const i = cellIndex(t);
        if (i < 0 || !anim || e.busy) return;
        if (isPlaying()) stop(e, false);
        const mod = ev.metaKey || ev.ctrlKey;
        if (ev.shiftKey) {
          const a = selectionAnchor(e);
          const range = Array.from({ length: Math.abs(i - a) + 1 }, (_, k) => Math.min(a, i) + k);
          setSelectedFrames(e, mod ? [...selectedFrames(e), ...range] : range);
          selectFrame(e, i, true);
        } else if (mod) {
          const sel = new Set(selectedFrames(e));
          if (sel.has(i) && sel.size > 1) {
            sel.delete(i);
            setSelectedFrames(e, [...sel], i);
            // The current frame must stay selected: show another selected one.
            selectFrame(e, i === anim.current ? [...sel][0] : anim.current, true);
          } else {
            setSelectedFrames(e, [...sel, i], i);
            selectFrame(e, i, true);
          }
        } else selectFrame(e, i);
        strip.focus({ preventScroll: true });
      });
      strip.addEventListener('keydown', (ev) => {
        const anim = animationOf(e);
        if (!anim || e.busy) return;
        const go = (i: number) => {
          if (isPlaying()) stop(e, false);
          if (ev.shiftKey) {
            const a = selectionAnchor(e);
            setSelectedFrames(e, Array.from({ length: Math.abs(i - a) + 1 }, (_, k) => Math.min(a, i) + k));
            selectFrame(e, i, true);
          } else selectFrame(e, i);
        };
        const last = anim.frames.length - 1;
        if (ev.key === 'ArrowLeft') go(Math.max(0, anim.current - 1));
        else if (ev.key === 'ArrowRight') go(Math.min(last, anim.current + 1));
        else if (ev.key === 'Home') go(0);
        else if (ev.key === 'End') go(last);
        else if (ev.key === ' ') void e.runCommand('animation.play');
        else if (ev.key === 'Delete' || ev.key === 'Backspace') void e.runCommand('animation.delete-frames');
        else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') void e.runCommand('animation.select-all');
        else return;
        ev.preventDefault();
        ev.stopPropagation();
      });
      // Drag frames to reorder them; a selected frame drags the whole selection.
      let dragging: number[] | undefined;
      const clearDrop = () => strip.querySelectorAll('[data-drop]').forEach((c) => c.removeAttribute('data-drop'));
      strip.addEventListener('dragstart', (ev) => {
        const i = cellIndex(ev.target);
        if (i < 0 || isPlaying()) return ev.preventDefault();
        const sel = selectedFrames(e);
        dragging = sel.includes(i) ? sel : [i];
        ev.dataTransfer?.setData('text/plain', `frames:${dragging.join(',')}`);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      const dropAt = (ev: DragEvent) => {
        const cell = (ev.target as HTMLElement).closest<HTMLElement>('[data-frame]');
        if (!cell) return undefined;
        const r = cell.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        return { cell, after, index: Number(cell.dataset.frame) + (after ? 1 : 0) };
      };
      strip.addEventListener('dragover', (ev) => {
        if (!dragging) return;
        const at = dropAt(ev);
        if (!at) return;
        ev.preventDefault();
        clearDrop();
        at.cell.dataset.drop = at.after ? 'after' : 'before';
      });
      strip.addEventListener('dragleave', (ev) => {
        if (!strip.contains(ev.relatedTarget as Node | null)) clearDrop();
      });
      strip.addEventListener('drop', (ev) => {
        const at = dropAt(ev);
        const moving = dragging;
        clearDrop();
        dragging = undefined;
        if (!at || !moving) return;
        ev.preventDefault();
        // The target counts only frames that are not moving.
        const target = at.index - moving.filter((m) => m < at.index).length;
        e.command('Move Frames', (d) => moveFrames(d, moving, target));
        setSelectedFrames(e, moving.map((_, k) => target + k));
        e.update();
      });
      strip.addEventListener('dragend', () => {
        dragging = undefined;
        clearDrop();
      });
    },
    update(e, el) {
      editor = e;
      host = el;
      // Thumbnail keys clone each frame; batch bursts of updates.
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        refresh();
      });
    },
  };
}

function delayItems(): MenuItem[] {
  return [...commands.values()].filter((c) => c.menu === 'animation.delay').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((c) => c.id);
}
function loopItems(): MenuItem[] {
  return [...commands.values()].filter((c) => c.menu === 'animation.loop').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((c) => c.id);
}
