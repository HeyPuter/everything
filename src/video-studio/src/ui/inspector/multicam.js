/**
 * Multi-camera tab: one card per angle with its picture at the playhead
 * (refreshed when the playhead stops), click a card or press its number
 * to show that angle from the playhead on (also while playing); where the
 * sound comes from; the list of cuts; and flattening into plain clips.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US, timecode } from '../../lib/time.js';
import { sourceTimeAt } from '../../model/timeline.js';
import { angleTracks, angleName, angleAt, visibleCuts } from '../../model/multicam.js';
import { propSection, row, note, uidFor, keepFocus } from './common.js';

const THUMB_W = 160;
const THUMB_H = 90;
// How long the playhead has to rest before the pictures are refreshed.
const SETTLE_MS = 250;

/** Inner time of the clip at the playhead, clamped to the part on the timeline. */
const innerAt = (c, t) => Math.min(c.in + c.duration - 1, Math.max(c.in, t - c.start + c.in));

export function multicamTab(view) {
  const { ctx } = view;
  const media = ctx.media;
  const c0 = view.clip;
  const count = angleTracks(c0).length;

  // --- Angle cards ------------------------------------------------------------
  const cards = Array.from({ length: count }, (_, i) => {
    const cv = h('canvas.mc-thumb', { width: THUMB_W, height: THUMB_H, 'aria-hidden': 'true' });
    const name = h('span.mc-card-name');
    const card = h('button.mc-card', { type: 'button', 'aria-pressed': 'false' }, cv, h('span.mc-card-foot', h('span.mc-card-num', String(i + 1)), name));
    card.addEventListener('click', () => view.actions.switchAngle(i, view.id));
    return { card, cv, name };
  });
  const grid = h('div.mc-grid', { role: 'group', 'aria-label': 'Angles' }, ...cards.map((x) => x.card));
  const keysNote = note(`Click an angle or press 1 to ${Math.min(9, count)} to show it from the playhead on. It works while playing too, so you can cut live.`, 'keyboard');

  /** The angle clip and source time under the playhead, or null where the angle has no footage. */
  function frameOf(c, i, inner) {
    const t = angleTracks(c)[i];
    const child = t?.clips.find((x) => inner >= x.start && inner < x.start + x.duration);
    const asset = child && view.project.assets[child.assetId];
    return asset ? { asset, sec: sourceTimeAt(child, inner) / US } : null;
  }

  let pending = false;
  function drawThumbs() {
    const c = view.clip;
    if (!c || !media) return;
    const inner = innerAt(c, view.store.time);
    pending = false;
    cards.forEach(({ cv }, i) => {
      const g = cv.getContext('2d');
      if (!g) return;
      g.fillStyle = '#000';
      g.fillRect(0, 0, THUMB_W, THUMB_H);
      const f = frameOf(c, i, inner);
      if (!f) {
        g.fillStyle = '#8d8d96';
        g.font = '12px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('No picture here', THUMB_W / 2, THUMB_H / 2 + 4);
        return;
      }
      const bmp = media.thumb(f.asset, Math.max(0, Math.min(f.sec, f.asset.duration / US - 0.05)), 0.1);
      if (!bmp) {
        pending = true;
        return;
      }
      // Fit the whole picture, as the player does.
      const k = Math.min(THUMB_W / bmp.width, THUMB_H / bmp.height);
      g.drawImage(bmp, (THUMB_W - bmp.width * k) / 2, (THUMB_H - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    });
  }
  const offThumb = media?.on('thumb', () => {
    if (!grid.isConnected) offThumb?.();
    else if (pending) drawThumbs();
  });

  let timer = 0;
  function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (grid.isConnected) drawThumbs();
      else offThumb?.();
    }, SETTLE_MS);
  }

  function markActive() {
    const c = view.clip;
    if (!c?.multicam) return;
    const inside = view.store.time >= c.start && view.store.time < c.start + c.duration;
    const active = angleAt(c.multicam, innerAt(c, view.store.time));
    const sound = c.multicam.audio;
    cards.forEach(({ card, name }, i) => {
      const on = inside && i === active;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', String(on));
      const label = angleName(c, i);
      if (name.textContent !== label) name.textContent = label;
      const heard = sound === 'follow' ? on : sound === i;
      card.classList.toggle('heard', heard);
      card.setAttribute('aria-label', `Angle ${i + 1}: ${label}${heard ? ', sound' : ''}`);
      card.setAttribute('data-tip', `Show ${label} from the playhead (${i + 1})`);
    });
  }
  view.bind(() => {
    markActive();
    settle();
  });
  view.bind(() => {
    markActive();
    settle();
  }, { time: true });

  // --- Sound --------------------------------------------------------------------
  const soundId = uidFor('mc-sound');
  const soundSel = h('select.select', { id: soundId },
    h('option', { value: 'follow' }, 'The angle that shows'),
    ...Array.from({ length: count }, (_, i) => h('option', { value: String(i) })));
  soundSel.addEventListener('change', () => view.actions.setMulticamAudio(soundSel.value === 'follow' ? 'follow' : Number(soundSel.value), view.id));
  view.bind(() => {
    const c = view.clip;
    if (!c?.multicam) return;
    [...soundSel.options].slice(1).forEach((o, i) => {
      const clipAt = angleTracks(c)[i]?.clips[0];
      const silent = clipAt && !view.project.assets[clipAt.assetId]?.hasAudio;
      o.textContent = `${i + 1}. ${angleName(c, i)}${silent ? ' (no sound)' : ''}`;
    });
    soundSel.value = String(c.multicam.audio);
  });

  // --- Cuts -----------------------------------------------------------------------
  const cutList = h('ol.mc-cuts', { 'aria-label': 'Angle cuts' });
  const emptyCuts = h('p.insp-empty', 'No cuts yet. Switch angles while the clip plays, or at the playhead.');
  let cutSig = '';
  view.bind(() => {
    const c = view.clip;
    if (!c?.multicam) return;
    const cuts = visibleCuts(c);
    const first = angleAt(c.multicam, c.in);
    const sig = `${c.start}|${c.in}|${c.duration}|${first}|${JSON.stringify(cuts)}|${angleTracks(c).map((t) => t.name).join('/')}`;
    if (sig === cutSig) return;
    cutSig = sig;
    const fps = view.store.fps;
    const rowFor = (t, angle, removable) => {
      const at = c.start + t - c.in;
      const go = h('button.icon-btn.small', { type: 'button', 'aria-label': `Go to ${timecode(at, fps)}`, 'data-tip': 'Go to' }, icon('arrowRight', 14));
      go.addEventListener('click', () => view.store.seek(at));
      const del = removable ? h('button.icon-btn.small', { type: 'button', 'aria-label': `Delete the cut at ${timecode(at, fps)}`, 'data-tip': 'Delete cut' }, icon('trash', 14)) : null;
      // The list is rebuilt without this cut: focus goes to the cut that takes its place, or the one before.
      del?.addEventListener('click', () => {
        const at = [...cutList.children].indexOf(del.closest('li'));
        keepFocus(() => view.actions.removeMulticamCut(t, view.id), () => cutList.children[at]?.querySelector('button:last-of-type'), () => cutList.children[at - 1]?.querySelector('button:last-of-type'), () => cutList.querySelector('button'));
      });
      return h('li.mc-cut', h('span.mc-cut-time', removable ? timecode(at, fps) : 'Start'), h('span.mc-cut-num', String(angle + 1)), h('span.mc-cut-name', angleName(c, angle)), go, del);
    };
    cutList.replaceChildren(rowFor(c.in, first, false), ...cuts.map((x) => rowFor(x.t, x.angle, true)));
    emptyCuts.hidden = cuts.length > 0;
  });

  // --- Flatten ----------------------------------------------------------------------
  const flatten = h('button.btn', { type: 'button' }, icon('rows', 16), 'Flatten');
  flatten.addEventListener('click', () => view.actions.flattenMulticam(view.id));
  const open = h('button.btn', { type: 'button' }, icon('layers', 16), 'Open to edit');
  open.addEventListener('click', () => view.actions.openCompound(view.id));

  return h('div.mc-tab',
    propSection('Angles', [grid, keysNote]),
    propSection('Sound', [row('Sound from', soundSel, { id: soundId })]),
    propSection('Cuts', [cutList, emptyCuts]),
    propSection('Multi-camera clip', [
      h('div.insp-actions', flatten, open),
      note('Flatten replaces the clip by the parts of each angle that show, plus the sound. Open it to trim or adjust the angles themselves.'),
    ]),
  );
}
