/**
 * Media housekeeping: remove media no clip uses, find media whose file is
 * missing and point it at a new file, swap an asset's file everywhere it is
 * used, and show where an asset is on the timeline.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import * as T from '../model/timeline.js';
import { allClipsDeep } from '../model/compound.js';
import { storedTimelineTracks } from '../model/timelines.js';
import { openDialog, confirmDialog, toast } from './dialog.js';

/** Assets no clip refers to (directly, or through a reversed copy in use). */
export function unusedAssets(project) {
  const used = new Set();
  for (const c of allClipsDeep(project)) if (c.assetId) used.add(c.assetId);
  // A reversed copy keeps its original alive, and the other way round.
  for (const a of Object.values(project.assets)) {
    if (a.reversedOf && (used.has(a.id) || used.has(a.reversedOf))) {
      used.add(a.id);
      used.add(a.reversedOf);
    }
  }
  return Object.values(project.assets).filter((a) => !used.has(a.id));
}

/** An import error that says which file it is about (several files may be imported at once). */
export function importErrorText(file, err) {
  const msg = err?.message || `Couldn't import ${file.name || 'this file'}.`;
  return file.name && !msg.includes(file.name) ? `${file.name}: ${msg}` : msg;
}

/** Audio clips playing an asset's sound (they can't use a photo). */
function soundClips(project, assetId) {
  return allClipsDeep(project).filter((c) => c.assetId === assetId && c.type === 'audio');
}

/**
 * Point every clip using oldId at a new asset and drop the old one. A photo
 * replacing a video turns its clips into photo clips (as Replace clip does)
 * and removes the audio clips that played the video's sound.
 */
export function swapAsset(project, oldId, asset) {
  const old = project.assets[oldId];
  project.assets[asset.id] = { ...asset, ...(old?.folder ? { folder: old.folder } : {}) };
  const toImage = asset.kind === 'image' && old?.kind !== 'image';
  if (toImage && oldId !== asset.id) {
    const sound = new Set(soundClips(project, oldId).map((c) => c.id));
    if (sound.size) {
      const strip = (tracks) => {
        for (const t of tracks) {
          t.clips = t.clips.filter((c) => !sound.has(c.id));
          for (const c of t.clips) if (c.type === 'compound') strip(c.sequence.tracks);
        }
      };
      strip(project.tracks);
      for (const tracks of storedTimelineTracks(project)) strip(tracks);
    }
  }
  let n = 0;
  for (const c of allClipsDeep(project)) {
    if (c.assetId === oldId) {
      c.assetId = asset.id;
      if (c.name === old?.name) c.name = asset.name;
      if (toImage && c.type === 'video') {
        c.type = 'image';
        c.in = 0;
        c.freeze = false;
        c.reversed = false;
      }
      n++;
    }
  }
  if (oldId !== asset.id) delete project.assets[oldId];
  return n;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

const ACCEPT = { video: 'video/*,.mkv,.mov,.m4v,.webm', audio: 'audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus', image: 'image/*' };

export function createMediaActions(ctx) {
  const { store } = ctx;
  /** Tell the media panel which files are missing. */
  const markMissing = (list) => {
    const media = ctx.media;
    if (!media?.missing) return;
    const next = new Set(list.map((x) => x.hash));
    if (next.size === media.missing.size && [...next].every((x) => media.missing.has(x))) return;
    media.missing = next;
    media.emit?.('missing');
  };
  const a = {
    async removeUnusedMedia() {
      // Inside a compound clip, media used anywhere in the project counts.
      const list = unusedAssets(store.projectForSave ? store.projectForSave() : store.project);
      if (!list.length) {
        toast('Every item in the media library is used on the timeline.', { kind: 'info' });
        return 0;
      }
      const ok = await confirmDialog({ title: 'Remove unused media?', message: `${list.length} item${list.length === 1 ? '' : 's'} not used on the timeline will be removed from this project's media library.`, confirm: 'Remove', danger: true });
      if (!ok) return 0;
      store.update('Remove unused media', (p) => {
        for (const x of list) delete p.assets[x.id];
      }, { structural: false });
      announce(`${list.length} unused items removed`);
      return list.length;
    },

    /**
     * The asset ids in ids that clips outside the compound clip being edited
     * use: deleting them from inside would leave those clips without media.
     */
    usedOutsideCompound(ids) {
      if (!store.nest?.length) return [];
      const uses = (p) => {
        const n = new Map();
        for (const c of allClipsDeep(p)) if (c.assetId) n.set(c.assetId, (n.get(c.assetId) || 0) + 1);
        return n;
      };
      const all = uses(store.projectForSave());
      const here = uses(store.project);
      return ids.filter((id) => (all.get(id) || 0) > (here.get(id) || 0));
    },

    /** Select every clip using an asset and jump to the first. */
    revealAsset(assetId) {
      const clips = T.allClips(store.project).filter((c) => c.assetId === assetId).sort((x, y) => x.start - y.start);
      if (!clips.length) {
        toast('This item is not on the timeline.', { kind: 'info' });
        return;
      }
      store.select(clips.map((c) => c.id));
      store.seek(clips[0].start);
      announce(`${clips.length} clip${clips.length === 1 ? '' : 's'} selected`);
    },

    /** Choose a new file for an asset; every clip using it switches over. */
    async replaceAssetFile(assetId) {
      const old = store.project.assets[assetId];
      if (!old) return null;
      const file = await pickFile(ACCEPT[old.kind] || '');
      if (!file) return null;
      let asset;
      try {
        asset = await ctx.library.importFile(file);
      } catch (err) {
        toast(importErrorText(file, err), { kind: 'error' });
        return null;
      }
      if (asset.kind !== old.kind && !(old.kind === 'video' && asset.kind === 'image')) {
        toast(`${file.name} is ${asset.kind === 'audio' ? 'an audio file' : asset.kind === 'image' ? 'a photo' : 'a video'}, not ${old.kind === 'audio' ? 'audio' : old.kind === 'image' ? 'a photo' : 'a video'}.`, { kind: 'error' });
        return null;
      }
      // A photo can't play the video's sound: its audio clips go, after asking.
      const sound = asset.kind === 'image' && old.kind === 'video' ? soundClips(store.projectForSave?.() || store.project, assetId).length : 0;
      if (sound && !(await confirmDialog({ title: 'Replace with a photo?', message: `${sound} audio clip${sound === 1 ? '' : 's'} playing the sound of ${old.name} will be removed, since a photo has no sound.`, confirm: 'Replace', danger: true }))) return null;
      // Clips outside the compound clip being edited use it too: switch them all.
      if (a.usedOutsideCompound([assetId]).length) while (store.nest.length) store.closeCompound();
      let n = 0;
      store.update('Replace media file', (p) => {
        n = swapAsset(p, assetId, asset);
      });
      if (asset.duration && old.duration && asset.duration < old.duration) toast('The new file is shorter, so some clips may now run past its end.', { kind: 'info' });
      announce(`${n} clip${n === 1 ? '' : 's'} now use ${asset.name}`);
      return asset;
    },

    /**
     * Find the project's media whose file is missing and mark it in the media
     * panel. notify: say so with a way to relink (when a project opens).
     * Resolves the number missing (0 when the check could not run).
     */
    async checkMissingMedia({ notify = false } = {}) {
      const assets = Object.values(store.project.assets);
      if (!assets.length) return 0;
      let missing;
      try {
        missing = await ctx.library.missingMedia(assets);
      } catch {
        return 0;
      }
      markMissing(missing);
      const n = missing.length;
      if (n && notify) toast(`${n} media file${n === 1 ? ' is' : 's are'} missing. Their clips show as black or silent.`, { kind: 'error', duration: 10000, action: { label: 'Find files', onClick: () => a.findMissingMedia() } });
      return n;
    },

    /** Check every asset's file in storage and offer to relink the missing ones. */
    async findMissingMedia() {
      let missing;
      try {
        missing = await ctx.library.missingMedia(Object.values(store.project.assets));
      } catch (err) {
        console.error(err);
        toast("Couldn't check the media files. Check your connection and try again.", { kind: 'error' });
        return [];
      }
      markMissing(missing);
      if (!missing.length) {
        toast('All media files are present.', { kind: 'success' });
        return [];
      }
      const rows = missing.map((x) => {
        const btn = h('button.btn.small', { type: 'button' }, icon('folderOpen', 14), 'Choose file...');
        const row = h('li.missing-row', icon(x.kind === 'audio' ? 'music' : x.kind === 'image' ? 'image' : 'film', 16), h('span.missing-name', x.name), btn);
        btn.addEventListener('click', async () => {
          const made = await a.replaceAssetFile(x.id);
          if (made) {
            row.classList.add('fixed');
            btn.replaceWith(h('span.missing-ok', icon('check', 14), 'Relinked'));
          }
        });
        return row;
      });
      const done = h('button.btn.primary', { type: 'button' }, 'Done');
      const d = openDialog({ title: 'Missing media', body: h('div', h('p.dialog-text', `${missing.length} file${missing.length === 1 ? ' is' : 's are'} missing. Choose a file for each to put it back on the timeline.`), h('ul.missing-list', rows)), actions: [done], className: 'small' });
      done.addEventListener('click', () => d.close());
      return missing;
    },
  };
  return a;
}
