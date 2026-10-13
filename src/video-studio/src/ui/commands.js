/**
 * Command registry: every menu item, toolbar button and keyboard shortcut
 * maps to a command id here, so the shortcut list in the help dialog is
 * always accurate.
 */
import { matchShortcut } from '../lib/platform.js';
import { US } from '../lib/time.js';
import { editPoint, findClip } from '../model/timeline.js';
import { isMulticam } from '../model/multicam.js';
import { prefs, setPref } from './prefs.js';

/** Groups shown in the Keyboard shortcuts dialog. */
export const SHORTCUT_GROUPS = ['Playback', 'Editing', 'Timeline', 'Markers and range', 'Player', 'File', 'Help'];

/** Keys that can't be rebound because the browser or the editor owns them. */
export const RESERVED_KEYS = ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+R', 'Mod+L', 'Tab', 'Shift+Tab', 'Enter'];

export function createCommands(ctx) {
  const { store, actions } = ctx;
  const player = () => ctx.player;
  const timeline = () => ctx.timeline;
  const step = (frames) => store.seek(store.time + Math.round((frames * US) / store.fps));
  const hasSel = () => store.selection.size > 0;
  const multicamSel = () => isMulticam(store.selected?.clip);
  const stepTimeline = (dir) => {
    const list = ctx.timelines?.list() || [];
    const i = list.findIndex((t) => t.active);
    if (list.length > 1) ctx.timelines.open(list[(i + dir + list.length) % list.length].id);
  };

  const list = [
    // Playback
    { id: 'play', label: 'Play or pause', group: 'Playback', keys: ['Space'], run: () => player()?.toggle() },
    { id: 'frameBack', label: 'Previous frame', group: 'Playback', keys: ['ArrowLeft'], run: () => step(-1) },
    { id: 'frameForward', label: 'Next frame', group: 'Playback', keys: ['ArrowRight'], run: () => step(1) },
    { id: 'framesBack', label: 'Back 10 frames', group: 'Playback', keys: ['Shift+ArrowLeft'], run: () => step(-10) },
    { id: 'framesForward', label: 'Forward 10 frames', group: 'Playback', keys: ['Shift+ArrowRight'], run: () => step(10) },
    { id: 'prevEdit', label: 'Previous edit point', group: 'Playback', keys: ['ArrowUp'], run: () => store.seek(editPoint(store.project, store.time, -1)) },
    { id: 'nextEdit', label: 'Next edit point', group: 'Playback', keys: ['ArrowDown'], run: () => store.seek(editPoint(store.project, store.time, 1)) },
    { id: 'toStart', label: 'Go to start', group: 'Playback', keys: ['Home'], run: () => store.seek(0) },
    { id: 'toEnd', label: 'Go to end', group: 'Playback', keys: ['End'], run: () => store.seek(store.duration) },
    { id: 'playRange', label: 'Play in to out', group: 'Playback', keys: ['Shift+Space'], run: () => (player()?.playing ? player().pause() : player()?.play({ range: true })), enabled: () => Boolean(store.project.range) },
    { id: 'toggleLoop', label: 'Loop playback', group: 'Playback', keys: ['Mod+Shift+L'], run: () => ctx.toggleLoop?.(), checked: () => Boolean(ctx.player?.loop) },
    { id: 'shuttleBack', label: 'Shuttle back one second', group: 'Playback', keys: ['J'], run: () => { player()?.pause(); step(-store.fps); } },
    { id: 'shuttleStop', label: 'Shuttle stop', group: 'Playback', keys: ['K'], run: () => player()?.pause() },
    { id: 'shuttleForward', label: 'Shuttle play', group: 'Playback', keys: ['L'], run: () => player()?.play() },

    // Editing
    { id: 'undo', label: 'Undo', group: 'Editing', keys: ['Mod+Z'], run: () => store.undo(), enabled: () => store.history.canUndo() },
    { id: 'history', label: 'Show history', group: 'Editing', keys: ['Mod+Shift+H'], run: () => ctx.history?.toggle() },
    { id: 'redo', label: 'Redo', group: 'Editing', keys: ['Mod+Shift+Z', 'Mod+Y'], run: () => store.redo(), enabled: () => store.history.canRedo() },
    { id: 'split', label: 'Split', group: 'Editing', keys: ['Mod+B'], run: () => actions.split() },
    { id: 'deleteLeft', label: 'Delete left of playhead', group: 'Editing', keys: ['Q'], run: () => actions.deleteLeft() },
    { id: 'deleteRight', label: 'Delete right of playhead', group: 'Editing', keys: ['W'], run: () => actions.deleteRight() },
    { id: 'delete', label: 'Delete', group: 'Editing', keys: ['Delete', 'Backspace'], run: () => actions.deleteSelected(), enabled: hasSel },
    { id: 'copy', label: 'Copy', group: 'Editing', keys: ['Mod+C'], run: () => actions.copy(), enabled: hasSel },
    { id: 'cut', label: 'Cut', group: 'Editing', keys: ['Mod+X'], run: () => actions.cut(), enabled: hasSel },
    { id: 'paste', label: 'Paste', group: 'Editing', keys: ['Mod+V'], run: () => actions.paste(), enabled: () => actions.hasClipboard() },
    { id: 'duplicate', label: 'Duplicate', group: 'Editing', keys: ['Mod+D'], run: () => actions.duplicate(), enabled: hasSel },
    { id: 'selectAll', label: 'Select all', group: 'Editing', keys: ['Mod+A'], run: () => actions.selectAll() },
    { id: 'findReplace', label: 'Find and replace text', group: 'Editing', keys: ['Mod+F'], run: () => import('./find-replace.js').then((m) => m.openFindReplace(ctx)) },
    { id: 'deselect', label: 'Deselect', group: 'Editing', keys: ['Escape'], run: () => store.clearSelection() },
    { id: 'freeze', label: 'Freeze frame', group: 'Editing', keys: ['Alt+F'], run: () => actions.freeze() },
    { id: 'detachAudio', label: 'Detach audio', group: 'Editing', keys: ['Alt+D'], run: () => actions.detachAudio() },
    { id: 'mirror', label: 'Mirror', group: 'Editing', keys: [], run: () => actions.mirror(), enabled: hasSel },
    { id: 'rotate', label: 'Rotate 90 degrees', group: 'Editing', keys: [], run: () => actions.rotate(), enabled: hasSel },
    { id: 'keyframe', label: 'Add keyframe', group: 'Editing', keys: ['Alt+K'], run: () => actions.addKeyframeAll(), enabled: () => Boolean(store.selected) },
    { id: 'addText', label: 'Add text', group: 'Editing', keys: ['Alt+T'], run: () => actions.addText() },
    { id: 'toggleDisabled', label: 'Enable or disable clip', group: 'Editing', keys: ['V'], run: () => actions.toggleDisabled(), enabled: hasSel },
    { id: 'group', label: 'Group clips', group: 'Editing', keys: ['Mod+G'], run: () => actions.group(), enabled: () => store.selection.size > 1 },
    { id: 'ungroup', label: 'Ungroup clips', group: 'Editing', keys: ['Mod+Shift+G'], run: () => actions.ungroup(), enabled: hasSel },
    { id: 'compound', label: 'Create compound clip', group: 'Editing', keys: ['Alt+G'], run: () => actions.createCompound(), enabled: hasSel },
    { id: 'breakApart', label: 'Break apart compound clip', group: 'Editing', keys: ['Alt+Shift+G'], run: () => actions.breakApartCompound(), enabled: () => store.selected?.clip.type === 'compound' },
    { id: 'multicam', label: 'Create multi-camera clip', group: 'Editing', keys: [], run: () => actions.createMulticam(), enabled: () => store.selection.size > 1 },
    { id: 'flattenMulticam', label: 'Flatten multi-camera clip', group: 'Editing', keys: [], run: () => actions.flattenMulticam(), enabled: multicamSel },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `angle${n}`, label: `Switch to angle ${n}`, group: 'Editing', keys: [String(n)], run: () => actions.switchAngle(n - 1), enabled: multicamSel })),
    { id: 'closeCompound', label: 'Back to the outer timeline', group: 'Editing', keys: [], run: () => actions.closeCompound(), enabled: () => store.nest?.length > 0 },
    { id: 'splitAll', label: 'Split all tracks', group: 'Editing', keys: ['Mod+Shift+B'], run: () => actions.splitAll() },
    { id: 'copyAttributes', label: 'Copy attributes', group: 'Editing', keys: ['Mod+Alt+C'], run: () => actions.copyAttributes(), enabled: hasSel },
    { id: 'pasteAttributes', label: 'Paste attributes', group: 'Editing', keys: ['Mod+Alt+V'], run: () => actions.pasteAttributes(), enabled: () => actions.hasAttributes() && hasSel() },
    { id: 'crop', label: 'Crop', group: 'Editing', keys: ['Alt+C'], run: () => ctx.openCrop?.(), enabled: () => ['video', 'image'].includes(store.selected?.clip.type) },
    { id: 'splitScenes', label: 'Split at scene changes', group: 'Editing', keys: [], run: () => actions.splitScenes(), enabled: () => store.selected?.clip.type === 'video' },
    { id: 'removeSilences', label: 'Remove silences', group: 'Editing', keys: [], run: () => actions.removeSilences() },
    { id: 'trackMotion', label: 'Track motion', group: 'Editing', keys: [], run: () => ctx.openTracking?.(), enabled: () => Boolean(store.selected && 'transform' in store.selected.clip) },
    { id: 'savePreset', label: 'Save clip as preset', group: 'Editing', keys: [], run: () => import('./clip-presets.js').then((m) => m.saveClipPreset(ctx)), enabled: () => Boolean(store.selected) },
    { id: 'managePresets', label: 'Manage clip presets', group: 'Editing', keys: [], run: () => import('./clip-presets.js').then((m) => m.managePresets(ctx)) },
    { id: 'removeBackground', label: 'Remove background', group: 'Editing', keys: [], run: () => actions.removeBackground(), enabled: () => [...store.selection].some((id) => /^(video|image)$/.test(findClip(store.project, id)?.clip.type || '')) },
    { id: 'stabilize', label: 'Stabilize', group: 'Editing', keys: [], run: () => actions.stabilize(), enabled: () => store.selected?.clip.type === 'video' },
    { id: 'removeFlicker', label: 'Remove flicker', group: 'Editing', keys: [], run: () => actions.removeFlicker(), enabled: () => store.selected?.clip.type === 'video' && !store.selected.clip.freeze },
    { id: 'extractAudio', label: 'Extract audio', group: 'Editing', keys: [], run: () => actions.extractAudio(), enabled: () => store.selected?.clip.type === 'video' && Boolean(store.project.assets[store.selected.clip.assetId]?.hasAudio) },
    { id: 'autoReframe', label: 'Auto reframe', group: 'Editing', keys: [], run: () => actions.autoReframe() },
    { id: 'findHighlights', label: 'Find highlights', group: 'Editing', keys: [], run: () => ctx.openHighlights?.() },
    { id: 'syncBySound', label: 'Sync two clips by sound', group: 'Editing', keys: [], run: () => actions.syncBySound(), enabled: () => store.selection.size === 2 },
    { id: 'reverse', label: 'Reverse clip', group: 'Editing', keys: [], run: () => actions.reverseClip(), enabled: () => store.selected?.clip.type === 'video' },
    { id: 'easeIn', label: 'Keyframe: ease in', group: 'Editing', keys: [], run: () => actions.setKeyEase('easeIn'), enabled: () => Boolean(store.selected) },
    { id: 'easeOut', label: 'Keyframe: ease out', group: 'Editing', keys: [], run: () => actions.setKeyEase('easeOut'), enabled: () => Boolean(store.selected) },
    { id: 'easeInOut', label: 'Keyframe: ease in and out', group: 'Editing', keys: [], run: () => actions.setKeyEase('easeInOut'), enabled: () => Boolean(store.selected) },
    { id: 'easeLinear', label: 'Keyframe: linear', group: 'Editing', keys: [], run: () => actions.setKeyEase('linear'), enabled: () => Boolean(store.selected) },
    { id: 'selectLeft', label: 'Select clips left of playhead', group: 'Editing', keys: ['BracketLeft'], run: () => actions.selectSide('left') },
    { id: 'selectRight', label: 'Select clips right of playhead', group: 'Editing', keys: ['BracketRight'], run: () => actions.selectSide('right') },

    // Markers and range
    { id: 'marker', label: 'Add marker', group: 'Markers and range', keys: ['M'], run: () => actions.addMarker() },
    { id: 'markerNewColor', label: 'Add marker in the next color', group: 'Markers and range', keys: ['Shift+M'], run: () => actions.addMarkerAt(store.time, { withNewColor: true }) },
    { id: 'prevMarker', label: 'Previous marker', group: 'Markers and range', keys: ['Shift+ArrowUp'], run: () => actions.goToMarker(-1) },
    { id: 'nextMarker', label: 'Next marker', group: 'Markers and range', keys: ['Shift+ArrowDown'], run: () => actions.goToMarker(1) },
    { id: 'markIn', label: 'Set in point', group: 'Markers and range', keys: ['I'], run: () => actions.markIn() },
    { id: 'markOut', label: 'Set out point', group: 'Markers and range', keys: ['O'], run: () => actions.markOut() },
    { id: 'markClip', label: 'Mark selected clips as range', group: 'Markers and range', keys: ['Shift+X'], run: () => actions.rangeFromSelection(), enabled: hasSel },
    { id: 'clearRange', label: 'Clear in and out points', group: 'Markers and range', keys: ['Alt+X'], run: () => actions.clearRange(), enabled: () => Boolean(store.project.range) },
    { id: 'cutRange', label: 'Cut in to out and close the gap', group: 'Markers and range', keys: ['Mod+Shift+X'], run: () => actions.removeRangeContent(true), enabled: () => Boolean(store.project.range) },
    { id: 'liftRange', label: 'Clear in to out, leave the gap', group: 'Markers and range', keys: [], run: () => actions.removeRangeContent(false), enabled: () => Boolean(store.project.range) },
    { id: 'goToIn', label: 'Go to in point', group: 'Markers and range', keys: ['Shift+I'], run: () => actions.goToIn(), enabled: () => Boolean(store.project.range) },
    { id: 'goToOut', label: 'Go to out point', group: 'Markers and range', keys: ['Shift+O'], run: () => actions.goToOut(), enabled: () => Boolean(store.project.range) },

    // Timeline
    { id: 'toggleKeyframePanel', label: 'Show or hide keyframe panel', group: 'Timeline', keys: ['Shift+K'], run: () => timeline()?.toggleKeyframePanel() },
    { id: 'zoomIn', label: 'Zoom in timeline', group: 'Timeline', keys: ['Mod+Equal'], run: () => timeline()?.zoomBy(1.4) },
    { id: 'zoomOut', label: 'Zoom out timeline', group: 'Timeline', keys: ['Mod+Minus'], run: () => timeline()?.zoomBy(1 / 1.4) },
    { id: 'zoomFit', label: 'Zoom to fit timeline', group: 'Timeline', keys: ['Shift+Z'], run: () => timeline()?.zoomToFit() },
    { id: 'toggleRipple', label: 'Ripple base track', group: 'Timeline', keys: ['R'], run: () => store.setToggle('ripple', !store.toggles.ripple), checked: () => store.toggles.ripple },
    { id: 'toggleSnap', label: 'Snapping', group: 'Timeline', keys: ['N'], run: () => store.setToggle('snap', !store.toggles.snap), checked: () => store.toggles.snap },
    { id: 'toggleLinkOverlays', label: 'Overlays follow base clips', group: 'Timeline', keys: ['Alt+L'], run: () => store.setToggle('linkOverlays', !store.toggles.linkOverlays), checked: () => store.toggles.linkOverlays },
    { id: 'toggleHoverPreview', label: 'Hover preview', group: 'Timeline', keys: ['H'], run: () => store.setToggle('hoverPreview', !store.toggles.hoverPreview), checked: () => store.toggles.hoverPreview },
    { id: 'selectTool', label: 'Select tool', group: 'Timeline', keys: ['A'], run: () => timeline()?.setTool('select') },
    { id: 'splitTool', label: 'Split tool', group: 'Timeline', keys: ['B'], run: () => timeline()?.setTool('split') },

    // Player
    { id: 'fullscreen', label: 'Full screen player', group: 'Player', keys: ['Mod+Shift+F'], run: () => ctx.playerView?.toggleFullscreen() },
    { id: 'playerZoomFit', label: 'Zoom to fit player', group: 'Player', keys: ['Shift+F'], run: () => ctx.playerView?.zoomFit() },
    { id: 'playerZoomIn', label: 'Zoom in player', group: 'Player', keys: ['Alt+Shift+Equal'], run: () => ctx.playerView?.zoomIn() },
    { id: 'playerZoomOut', label: 'Zoom out player', group: 'Player', keys: ['Alt+Shift+Minus'], run: () => ctx.playerView?.zoomOut() },
    { id: 'toggleRulers', label: 'Show or hide rulers', group: 'Player', keys: ['Mod+Alt+R'], run: () => ctx.playerView?.toggleRulers() },
    { id: 'toggleGuides', label: 'Show or hide guides', group: 'Player', keys: ['Mod+Semicolon'], run: () => ctx.playerView?.toggleGuides() },
    { id: 'exportStill', label: 'Export frame as image', group: 'File', keys: ['Mod+Alt+S'], run: () => ctx.exportStill?.() },

    // File
    { id: 'import', label: 'Import media', group: 'File', keys: ['Mod+I'], run: () => ctx.openImport?.() },
    { id: 'newTimeline', label: 'New timeline', group: 'File', keys: ['Mod+Alt+N'], run: () => ctx.timelines?.createWithDialog() },
    { id: 'duplicateTimeline', label: 'Duplicate timeline', group: 'File', keys: [], run: () => ctx.timelines?.duplicate() },
    { id: 'renameTimeline', label: 'Rename timeline', group: 'File', keys: [], run: () => ctx.timelines?.rename() },
    { id: 'prevTimeline', label: 'Previous timeline', group: 'File', keys: [], run: () => stepTimeline(-1), enabled: () => (ctx.timelines?.list().length || 0) > 1 },
    { id: 'nextTimeline', label: 'Next timeline', group: 'File', keys: [], run: () => stepTimeline(1), enabled: () => (ctx.timelines?.list().length || 0) > 1 },
    { id: 'export', label: 'Export', group: 'File', keys: ['Mod+E'], run: () => ctx.openExport?.() },
    { id: 'scriptToVideo', label: 'Script to video', group: 'File', keys: [], run: () => ctx.openScriptVideo?.() },
    { id: 'shareReview', label: 'Share for review', group: 'File', keys: [], run: () => ctx.openShareReview?.() },
    { id: 'reviewComments', label: 'Show review comments', group: 'File', keys: [], run: () => ctx.review?.toggle() },
    { id: 'save', label: 'Save now', group: 'File', keys: ['Mod+S'], run: () => ctx.saveNow?.() },

    { id: 'preferences', label: 'Preferences', group: 'File', keys: ['Mod+Comma'], run: () => ctx.openPreferences?.() },

    // Help
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', keys: ['Mod+Slash'], run: () => ctx.openShortcuts?.() },
  ];

  // Remember each command's own keys, then layer the user's rebinding on top.
  for (const c of list) c.defaultKeys = [...c.keys];
  const applyOverrides = () => {
    const custom = prefs().shortcuts || {};
    for (const c of list) c.keys = Array.isArray(custom[c.id]) ? custom[c.id].filter((k) => typeof k === 'string') : [...c.defaultKeys];
  };
  applyOverrides();

  const byId = new Map(list.map((c) => [c.id, c]));

  return {
    list,
    /** Rebind a command (keys = [] removes its shortcut); null restores the default. */
    setKeys(id, keys) {
      const custom = { ...(prefs().shortcuts || {}) };
      const c = byId.get(id);
      if (!c) return;
      if (keys === null || JSON.stringify(keys) === JSON.stringify(c.defaultKeys)) delete custom[id];
      else custom[id] = keys;
      setPref('shortcuts', custom);
      applyOverrides();
    },
    resetKeys() {
      setPref('shortcuts', {});
      applyOverrides();
    },
    /** Commands (other than id) already using a key. */
    conflicts(key, id) {
      return list.filter((c) => c.id !== id && c.keys.includes(key));
    },
    isCustom(id) {
      return Boolean((prefs().shortcuts || {})[id]);
    },
    get(id) {
      return byId.get(id);
    },
    run(id) {
      const c = byId.get(id);
      if (!c) return false;
      if (c.enabled && !c.enabled()) return false;
      c.run();
      return true;
    },
    keyFor(id) {
      return byId.get(id)?.keys?.[0] || '';
    },
    /** Dispatch a keydown; returns true when handled. */
    handleKey(e) {
      for (const c of list) {
        for (const k of c.keys) {
          if (matchShortcut(e, k)) {
            if (c.enabled && !c.enabled()) return true;
            c.run();
            return true;
          }
        }
      }
      return false;
    },
  };
}
