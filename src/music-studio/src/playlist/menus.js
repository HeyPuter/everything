// Playlist context menus and the source operations behind them: clips,
// empty canvas positions, track headers, picker sources and the ruler.

import * as E from '../model/edits.js';
import { COLORS } from '../model/project.js';
import { promptDialog, confirmDialog } from '../ui/dialog.js';
import { openMenu } from '../ui/menu.js';
import { formatKeys } from '../commands/registry.js';
import { announce } from '../lib/dom.js';
import { formatBST } from '../model/time.js';
import * as C from './clips.js';

const KIND_LABEL = { pattern: 'pattern', audio: 'audio clip', auto: 'automation' };

// ------------------------------------------------------------------ source operations

export async function renameSource(V, src) {
  const { store } = V;
  const name = C.sourceName(store.project, src);
  const v = await promptDialog({ title: `Rename ${KIND_LABEL[src.kind]}`, label: 'Name', value: name, confirm: 'Rename', validate: (s) => (s.trim() ? '' : 'Enter a name.') });
  if (!v) return;
  const next = v.trim().slice(0, 60);
  store.apply(`Rename ${KIND_LABEL[src.kind]}`, (p) => {
    if (src.kind === 'pattern') return E.updatePattern(p, src.id, { name: next });
    if (src.kind === 'audio') return E.updateChannel(p, src.id, { name: next });
    return E.updateAutomation(p, src.id, { name: next });
  });
}

function setSourceColor(V, src, color) {
  V.store.apply(`${KIND_LABEL[src.kind][0].toUpperCase()}${KIND_LABEL[src.kind].slice(1)} color`, (p) => {
    if (src.kind === 'pattern') return E.updatePattern(p, src.id, { color });
    if (src.kind === 'audio') return E.updateChannel(p, src.id, { color: color || COLORS[6] });
    return E.updateAutomation(p, src.id, { color });
  });
}

function colorItems(V, src) {
  const p = V.store.project;
  const cur = src.kind === 'pattern' ? p.patterns.find((x) => x.id === src.id)?.color : src.kind === 'audio' ? p.channels.find((c) => c.id === src.id)?.color : p.automation[src.id]?.color;
  return [
    src.kind === 'audio' ? null : { type: 'radio', label: 'Automatic', checked: !cur, run: () => setSourceColor(V, src, null) },
    ...COLORS.map((c, i) => ({ type: 'radio', label: `Color ${i + 1}`, swatch: c, checked: cur === c, run: () => setSourceColor(V, src, c) })),
  ].filter(Boolean);
}

export function cloneSource(V, src) {
  const { store } = V;
  let r;
  if (src.kind === 'pattern') r = store.apply('Clone pattern', (p) => E.clonePattern(p, src.id));
  else if (src.kind === 'audio') r = store.apply('Clone audio clip', (p) => E.cloneChannel(p, src.id));
  else {
    r = store.apply('Clone automation', (p) => {
      const a = p.automation[src.id];
      if (!a) return { project: p, id: null };
      const { id: _old, ...rest } = structuredClone(a);
      return E.addAutomation(p, { ...rest, name: `${a.name} #2` });
    });
  }
  if (r?.id) {
    V.setSource({ kind: src.kind, id: r.id });
    if (src.kind === 'pattern') store.setPattern(r.id);
  }
}

export async function deleteSource(V, src) {
  const { store } = V;
  const p = store.project;
  const name = C.sourceName(p, src);
  if (src.kind === 'pattern' && p.patterns.length <= 1) {
    V.app.notify('The last pattern cannot be deleted');
    return;
  }
  const used = p.clips.filter((c) => c.kind === src.kind && c.ref === src.id).length;
  if (used && !(await confirmDialog({ title: `Delete ${KIND_LABEL[src.kind]}`, message: `"${name}" is used by ${used} clip${used === 1 ? '' : 's'} in the playlist. Delete it and its clips?`, confirm: 'Delete', danger: true }))) return;
  store.apply(`Delete ${KIND_LABEL[src.kind]}`, (q) => {
    if (src.kind === 'pattern') return E.removePattern(q, src.id);
    if (src.kind === 'audio') return E.removeChannels(q, [src.id]);
    return E.removeAutomation(q, src.id);
  });
  announce(`Deleted ${name}`);
}

export function sourceMenu(V, src, at) {
  const p = V.store.project;
  const uses = p.clips.filter((c) => c.kind === src.kind && c.ref === src.id).map((c) => c.id);
  openMenu(
    [
      { type: 'cmd', label: src.kind === 'pattern' ? 'Open in channel rack' : src.kind === 'audio' ? 'Open channel settings' : 'Select its clips', enabled: src.kind !== 'audio' || Boolean(V.app.openChannelEditor), run: () => V.openSource(src) },
      { type: 'cmd', label: 'Rename...', keys: 'F2', run: () => renameSource(V, src) },
      { type: 'submenu', label: 'Color', items: () => colorItems(V, src) },
      { type: 'cmd', label: 'Clone', run: () => cloneSource(V, src) },
      { type: 'sep' },
      { type: 'cmd', label: `Select clips (${uses.length})`, enabled: uses.length > 0, run: () => V.selectClips(uses, { reveal: true }) },
      { type: 'cmd', label: 'Delete...', enabled: src.kind !== 'pattern' || p.patterns.length > 1, run: () => deleteSource(V, src) },
    ],
    { ...at, label: `${C.sourceName(p, src)} options` },
  );
}

// ------------------------------------------------------------------ clips

export function clipMenu(V, clip, at) {
  const { store, app } = V;
  const p = store.project;
  if (!V.selection.has(clip.id)) V.selectClips([clip.id]);
  const ids = [...V.selection];
  const src = C.sourceOf(clip);
  const pos = V.songPos();
  const cuttable = p.clips.some((c) => ids.includes(c.id) && c.start < pos && c.start + c.len > pos);
  const pattern = clip.kind === 'pattern';
  openMenu(
    [
      pattern ? { type: 'cmd', label: 'Open pattern', run: () => V.openClip(clip) } : null,
      clip.kind === 'audio' ? { type: 'cmd', label: 'Open channel settings', enabled: Boolean(app.openChannelEditor), run: () => app.openChannelEditor?.(clip.ref) } : null,
      { type: 'cmd', label: `Rename ${KIND_LABEL[clip.kind]}...`, run: () => renameSource(V, src) },
      { type: 'submenu', label: 'Color', items: () => colorItems(V, src) },
      { type: 'cmd', label: 'Make unique', run: () => V.makeUnique(clip.id) },
      { type: 'sep' },
      { type: 'check', label: 'Mute', checked: clip.mute, run: () => store.apply(clip.mute ? 'Unmute clips' : 'Mute clips', (q) => C.toggleClipMute(q, ids, !clip.mute)) },
      { type: 'cmd', label: 'Split at playhead', enabled: cuttable, run: () => V.splitAtPlayhead(ids) },
      { type: 'cmd', label: 'Duplicate', keys: app.commands.keysLabel('edit.duplicate'), run: () => V.actions.duplicate() },
      { type: 'cmd', label: 'Delete', keys: app.commands.keysLabel('edit.delete'), run: () => V.actions.delete() },
      { type: 'sep' },
      { type: 'cmd', label: 'Select source in picker', run: () => V.setSource(src, { focus: true }) },
      { type: 'cmd', label: 'Select all clips of this source', run: () => V.selectClips(p.clips.filter((c) => c.kind === clip.kind && c.ref === clip.ref).map((c) => c.id)) },
    ].filter(Boolean),
    { ...at, label: `${C.sourceName(p, src)} clip options` },
  );
}

export function emptyMenu(V, pt, at) {
  const { store } = V;
  const p = store.project;
  const name = V.source ? C.sourceName(p, V.source) : '';
  openMenu(
    [
      { type: 'cmd', label: name ? `Place "${name}" here` : 'Place clip here', enabled: Boolean(V.source && C.sourceExists(p, V.source)), run: () => V.placeAt(pt.track, V.snapFloor(pt.tick)) },
      { type: 'cmd', label: 'Paste here', enabled: Boolean(V.clipboard()), run: () => V.pasteAt(V.snapFloor(pt.tick), pt.track) },
      { type: 'sep' },
      { type: 'cmd', label: 'Select all clips on this track', run: () => V.selectClips(p.clips.filter((c) => c.track === pt.track).map((c) => c.id)) },
      { type: 'cmd', label: 'Add marker here', run: () => V.addMarker(V.snapFloor(pt.tick)) },
    ],
    { ...at, label: 'Playlist options' },
  );
}

// ------------------------------------------------------------------ tracks

export function trackMenu(V, i, at) {
  const { store } = V;
  const p = store.project;
  const t = p.tracks[i];
  if (!t) return;
  const setColor = (color) => store.apply('Track color', (q) => E.updateTrack(q, i, { color }));
  const height = t.height || C.TRACK_HEIGHTS.medium;
  openMenu(
    [
      { type: 'cmd', label: 'Rename...', keys: 'F2', run: () => V.headers.startRename(i) },
      { type: 'submenu', label: 'Color', items: () => [
        { type: 'radio', label: 'None', checked: !t.color, run: () => setColor(null) },
        ...COLORS.map((c, k) => ({ type: 'radio', label: `Color ${k + 1}`, swatch: c, checked: t.color === c, run: () => setColor(c) })),
      ] },
      { type: 'submenu', label: 'Height', items: () => Object.entries(C.TRACK_HEIGHTS).map(([k, v]) => ({ type: 'radio', label: k[0].toUpperCase() + k.slice(1), checked: height === v, run: () => store.apply('Track height', (q) => E.updateTrack(q, i, { height: v })) })) },
      { type: 'sep' },
      { type: 'cmd', label: 'Insert track above', run: () => {
        store.apply('Insert track', (q) => C.insertTrack(q, i));
        V.selectTrack(i);
      } },
      { type: 'cmd', label: 'Move up', keys: formatKeys('Alt+ArrowUp'), enabled: i > 0, run: () => {
        store.apply('Move track', (q) => E.moveTrack(q, i, i - 1));
        V.selectTrack(i - 1);
      } },
      { type: 'cmd', label: 'Move down', keys: formatKeys('Alt+ArrowDown'), enabled: i < p.tracks.length - 1, run: () => {
        store.apply('Move track', (q) => E.moveTrack(q, i, i + 1));
        V.selectTrack(i + 1);
      } },
      { type: 'sep' },
      { type: 'check', label: 'Mute', checked: t.mute, run: () => store.apply(t.mute ? 'Unmute track' : 'Mute track', (q) => E.updateTrack(q, i, { mute: !t.mute })) },
      { type: 'check', label: 'Solo', checked: Boolean(t.solo), run: () => store.apply('Solo track', (q) => C.soloTrack(q, i)) },
      { type: 'cmd', label: 'Mute other tracks', run: () => store.apply('Mute other tracks', (q) => C.muteOtherTracks(q, i)) },
      { type: 'cmd', label: 'Select all clips on track', run: () => V.selectClips(p.clips.filter((c) => c.track === i).map((c) => c.id)) },
      { type: 'sep' },
      { type: 'cmd', label: 'Delete track', run: async () => {
        const n = p.clips.filter((c) => c.track === i).length;
        if (n && !(await confirmDialog({ title: 'Delete track', message: `Delete "${t.name}" and its ${n} clip${n === 1 ? '' : 's'}? Tracks below move up.`, confirm: 'Delete', danger: true }))) return;
        store.apply('Delete track', (q) => C.deleteTrack(q, i));
        announce(`Deleted ${t.name}`);
      } },
    ],
    { ...at, label: `${t.name} options` },
  );
}

// ------------------------------------------------------------------ ruler

export function rulerMenu(V, tick, at, marker = null) {
  const { store } = V;
  const p = store.project;
  const near = marker || p.markers.find((m) => Math.abs(V.vp.x(m.pos) - V.vp.x(tick)) < 6);
  const bar = V.barTicks();
  const barStart = Math.floor(tick / bar) * bar;
  openMenu(
    [
      near ? { type: 'heading', label: `Marker "${near.name}"` } : null,
      near ? { type: 'cmd', label: 'Jump to marker', run: () => V.jumpToMarker(near) } : null,
      near ? { type: 'cmd', label: 'Rename marker...', run: () => V.renameMarker(near) } : null,
      near ? { type: 'cmd', label: 'Delete marker', run: () => V.deleteMarker(near) } : null,
      near ? { type: 'sep' } : null,
      { type: 'cmd', label: `Add marker at ${formatBST(V.snapFloor(tick), p.sig)}`, run: () => V.addMarker(V.snapFloor(tick)) },
      { type: 'sep' },
      { type: 'cmd', label: 'Loop this bar', run: () => store.apply('Set loop', (q) => E.setLoop(q, { start: barStart, end: barStart + bar })) },
      { type: 'cmd', label: 'Loop selected clips', enabled: V.selection.size > 0, run: () => V.loopSelection() },
      { type: 'cmd', label: 'Clear loop', enabled: Boolean(p.loop), run: () => store.apply('Clear loop', (q) => E.setLoop(q, null)) },
    ].filter(Boolean),
    { ...at, label: 'Timeline options' },
  );
}
