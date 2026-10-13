/**
 * Timelines list in the media panel: every timeline of the project with a
 * sketch of its tracks. Click opens one; + puts it into the open timeline
 * as a compound clip; the menu renames, duplicates or deletes.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { RATIOS } from '../../model/project.js';
import { listTimelines, timelineContents } from '../../model/timelines.js';
import { tileGrid, tile, emptyState } from './common.js';
import { showMenu } from '../menu.js';

const CLIP_VAR = { video: '--clip-video', image: '--clip-image', compound: '--clip-video', audio: '--clip-audio', text: '--clip-text', sticker: '--clip-sticker', effect: '--clip-effect', filter: '--clip-filter', adjust: '--clip-adjust' };

/** Changes when anything the list shows changes (names, order, lengths, which is open). */
export function timelinesSignature(project) {
  return listTimelines(project).map((t) => `${t.id}:${t.name}:${t.active ? 1 : 0}:${t.duration}:${t.clips}:${t.settings?.ratio}`).join('|');
}

/** A sketch of a timeline's tracks: one lane per track, clips as colored bars. */
export function drawTimelineSketch(g, tracks, duration, W, H) {
  const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const color = (type) => css?.getPropertyValue(CLIP_VAR[type] || '--clip-video').trim() || '#4f8ff7';
  g.fillStyle = css?.getPropertyValue('--bg-timeline').trim() || '#1b1c1f';
  g.fillRect(0, 0, W, H);
  const lanes = (tracks || []).filter((t) => t.clips.length).slice(0, 6);
  if (!lanes.length || duration <= 0) return;
  const pad = 8;
  const gap = 3;
  const laneH = Math.min(14, (H - pad * 2 - gap * (lanes.length - 1)) / lanes.length);
  const top = (H - (laneH * lanes.length + gap * (lanes.length - 1))) / 2;
  const span = W - pad * 2;
  lanes.forEach((t, i) => {
    const y = top + i * (laneH + gap);
    for (const c of t.clips) {
      const x = pad + (c.start / duration) * span;
      const w = Math.max(2, (c.duration / duration) * span - 1);
      g.fillStyle = color(c.type);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, laneH, 2);
      else g.rect(x, y, w, laneH);
      g.fill();
    }
  });
}

export function renderTimelines(ctx, q) {
  const tl = ctx.timelines;
  const all = tl.list();
  const list = all.filter((t) => !q || t.name.toLowerCase().includes(q));
  const newBtn = h('button.btn.small', { type: 'button' }, icon('timelinePlus', 14), 'New timeline');
  newBtn.addEventListener('click', () => tl.createWithDialog());
  const head = h('div.timelines-head', h('p.asset-hint', 'Timelines share this project\'s media. Make another cut, a short or a different shape, then switch between them here or above the player.'), newBtn);
  if (!list.length) return h('div.timelines-view', head, emptyState('search', 'No matches', 'Try another name.'));

  const menuFor = (t) => [
    { label: t.active ? 'Open (now open)' : 'Open', icon: 'folderOpen', disabled: t.active, onSelect: () => tl.open(t.id) },
    { label: 'Insert into the open timeline', icon: 'layers', disabled: t.active || !t.clips, onSelect: () => tl.insert(t.id) },
    'separator',
    { label: 'Rename...', icon: 'pencil', onSelect: () => tl.rename(t.id) },
    { label: 'Duplicate', icon: 'copy', onSelect: () => tl.duplicate(t.id) },
    { label: 'Delete...', icon: 'trash', danger: true, disabled: all.length < 2, onSelect: () => tl.remove(t.id) },
  ];

  const tiles = list.map((t) => {
    const cv = h('canvas.tile-canvas', { width: 160, height: 90, 'aria-hidden': 'true' });
    const g = cv.getContext?.('2d');
    if (g) drawTimelineSketch(g, timelineContents(ctx.store.project, t.id)?.tracks, t.duration, 160, 90);
    const ratio = RATIOS.find((r) => r.id === t.settings?.ratio)?.label || (t.settings ? `${t.settings.width}x${t.settings.height}` : '');
    const el = tile({
      label: t.name,
      preview: cv,
      badge: t.active ? 'Open' : ratio,
      sub: `${clock(t.duration)} · ${t.clips} clip${t.clips === 1 ? '' : 's'}`,
      active: t.active,
      addLabel: t.active ? `${t.name}, open now` : `Open ${t.name}`,
      onAdd: () => tl.open(t.id),
    });
    const extras = [];
    if (!t.active && t.clips) {
      const insert = h('button.tile-plus', { type: 'button', 'aria-label': `Insert ${t.name} into the open timeline`, 'data-tip': 'Insert into the open timeline' }, icon('plus', 14));
      insert.addEventListener('click', (e) => {
        e.stopPropagation();
        tl.insert(t.id);
      });
      extras.push(insert);
    }
    el.dataset.timeline = t.id;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, menuFor(t), { label: t.name });
    });
    const more = h('button.tile-more', { type: 'button', 'aria-label': `More for ${t.name}`, 'data-tip': 'More' }, icon('more', 14));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      showMenu(more, menuFor(t), { label: t.name });
    });
    extras.push(more);
    el.tileExtras = extras;
    return el;
  });
  return h('div.timelines-view', head, tileGrid(tiles, { label: 'Timelines', className: 'timelines-grid' }));
}
