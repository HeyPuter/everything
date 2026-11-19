// Menu bar structure. Items reference command ids; items whose command is not
// registered are left out, so feature modules light up their entries just by
// registering commands.
//
//   'cmd.id'                         a command
//   '-'                              separator
//   { label, submenu: [...] }        submenu
//   { label, items: (app) => [...] } dynamic submenu (e.g. Open Recent)
//   { expand: (app) => [...] }       spec items computed when the menu opens
//                                    (app is null when only paths are wanted)

import { VISIBILITY_MENU } from '../multitrack/visibility.js';

export const EFFECT_GROUPS = [
  { label: 'Amplitude and Compression', ids: ['amplify', 'channelMixer', 'deesser', 'dynamics', 'dynamicsProcessing', 'fadeEnvelope', 'gainEnvelope', 'hardLimiter', 'multibandCompressor', 'normalize', 'singleBandCompressor', 'speechVolumeLeveler', 'tubeCompressor'] },
  { label: 'Delay and Echo', ids: ['analogDelay', 'delay', 'echo'] },
  { label: 'Diagnostics', ids: ['declicker', 'declipper', 'deleteSilence', 'markAudio'] },
  { label: 'Filter and EQ', ids: ['fftFilter', 'graphicEq10', 'graphicEq20', 'graphicEq30', 'notchFilter', 'parametricEq', 'scientificFilter'] },
  { label: 'Modulation', ids: ['chorus', 'chorusFlanger', 'flanger', 'phaser'] },
  { label: 'Noise Reduction / Restoration', ids: ['captureNoisePrint', 'noiseReduction', '-', 'learnSoundModel', 'soundRemover', '-', 'clickPopEliminator', 'hissReduction', '-', 'adaptiveNoiseReduction', 'autoClickRemover', 'autoHeal', 'autoPhaseCorrection', 'dehummer', 'denoise', 'dereverb'] },
  { label: 'Reverb', ids: ['convolutionReverb', 'fullReverb', 'reverb', 'studioReverb', 'surroundReverb'] },
  { label: 'Special', ids: ['distortion', 'dopplerShifter', 'guitarSuite', 'loudnessMaximizer', 'mastering', 'loudnessMeter', 'vocalEnhancer'] },
  { label: 'Stereo Imagery', ids: ['centerChannelExtractor', 'graphicPhaseShifter', 'stereoExpander'] },
  { label: 'Time and Pitch', ids: ['automaticPitchCorrection', 'manualPitchCorrection', 'pitchBender', 'pitchShifter', 'stretchPitch'] },
];

/**
 * Groups items alphabetically into submenus of at most `max` entries, labelled
 * by their first letters ("A–C"). `items` are { id, label } sorted by label.
 */
export function alphabeticalGroups(items, max = 14) {
  const sorted = items.slice().sort((a, b) => a.label.localeCompare(b.label));
  const byLetter = new Map();
  for (const it of sorted) {
    const k = (it.label[0] || '#').toUpperCase();
    if (!byLetter.has(k)) byLetter.set(k, []);
    byLetter.get(k).push(it);
  }
  const groups = [];
  let cur = null;
  for (const [letter, list] of byLetter) {
    if (!cur || cur.items.length + list.length > max) {
      cur = { from: letter, to: letter, items: [] };
      groups.push(cur);
    }
    cur.to = letter;
    cur.items.push(...list);
  }
  return groups.map((g) => ({ label: g.from === g.to ? g.from : `${g.from}\u2013${g.to}`, items: g.items }));
}

/**
 * Effect submenus of the Effects menu: by category (EFFECT_GROUPS) or, with
 * Preferences > Effects > sort by name, alphabetical.
 */
export function effectMenuSpec(app) {
  if (app?.prefs?.get('fxMenuSort') !== 'name') return EFFECT_GROUPS.map((group) => ({ label: group.label, submenu: group.ids.map((id) => (id === '-' ? '-' : `fx.${id}`)) }));
  const items = EFFECT_GROUPS.flatMap((g) => g.ids)
    .filter((id) => id !== '-' && app.commands.get(`fx.${id}`))
    .map((id) => ({ id: `fx.${id}`, label: app.commands.label(`fx.${id}`) }));
  return alphabeticalGroups(items).map((g) => ({ label: g.label, submenu: g.items.map((it) => it.id) }));
}

export const MENUS = [
  {
    label: 'File',
    submenu: [
      { label: 'New', submenu: ['file.newSession', 'file.newAudio'] },
      'file.open',
      'file.openLocal',
      { label: 'Open Append', submenu: ['file.appendCurrent', 'file.appendNew'] },
      { label: 'Open Recent', items: (app) => app.recentMenuItems?.() || [] },
      { label: 'Import', submenu: ['file.import', 'file.importLocal', '-', 'file.importRaw', 'file.importMarkers', '-', 'file.importSettings'] },
      '-',
      'file.close',
      'file.closeAll',
      'file.closeUnused',
      'file.closeSessionMedia',
      '-',
      'file.save',
      'file.saveAs',
      'file.saveCopy',
      'file.saveSelectionAs',
      'file.saveAll',
      'file.saveAllBatch',
      'file.revert',
      'file.restoreBackup',
      '-',
      {
        label: 'Export',
        submenu: [
          'file.exportFile',
          'file.exportRanges',
          'file.exportMarkers',
          '-',
          { label: 'Multitrack Mixdown', submenu: ['export.mixdownSession', 'export.mixdownTime', 'export.mixdownClips'] },
          '-',
          'file.exportSession',
          'file.exportTemplate',
          'file.exportInterchange',
          '-',
          'file.download',
          '-',
          'file.exportSettings',
        ],
      },
      '-',
      'file.runScript',
      '-',
      'file.revealInMedia',
      'file.properties',
    ],
  },
  {
    label: 'Edit',
    submenu: [
      'edit.undo',
      'edit.redo',
      'edit.repeat',
      'edit.repeatNoDialog',
      '-',
      { label: 'Tools', submenu: ['tool.move', 'tool.razor', 'tool.slip', 'tool.time', 'tool.marquee', 'tool.lasso', 'tool.brush', 'tool.heal'] },
      '-',
      { label: 'Enable Channels', items: (app) => app.channelMenuItems?.() || [] },
      { label: 'Set Current Clipboard', submenu: ['edit.clipboard1', 'edit.clipboard2', 'edit.clipboard3', 'edit.clipboard4', 'edit.clipboard5'] },
      '-',
      'edit.cut',
      'edit.copy',
      'edit.copyToNew',
      'edit.paste',
      'edit.pasteToNew',
      'edit.mixPaste',
      'edit.delete',
      { label: 'Ripple Delete', submenu: ['edit.rippleClips', 'edit.rippleTimeClips', 'edit.rippleTimeTrack', 'edit.rippleTimeAll', 'edit.rippleGap'] },
      'edit.rename',
      '-',
      'edit.crop',
      'edit.trimToSelection',
      { label: 'Insert', submenu: [{ label: 'Into Multitrack Session', items: (app) => app.insertSessionMenuItems?.() || [] }, '-', 'edit.insertSilence'] },
      '-',
      {
        label: 'Select',
        submenu: [
          'edit.selectAll',
          'edit.deselect',
          'edit.selectView',
          'edit.selectInverse',
          'spectral.selectRange',
          '-',
          'edit.selectAllClipsTrack',
          'edit.selectNextClip',
          'edit.selectClipsToTrackEnd',
          '-',
          'edit.selectClipsToStart',
          'edit.selectClipsToEnd',
          { label: 'Clips of Audio Type', submenu: ['edit.selectClipsOfTypeDialogue', 'edit.selectClipsOfTypeMusic', 'edit.selectClipsOfTypeSfx', 'edit.selectClipsOfTypeAmbience'] },
          '-',
          'edit.selectAllTime',
          'edit.selectTimeAroundClips',
          'edit.clearTimeSelection',
        ],
      },
      { label: 'Marker', submenu: ['marker.add', 'marker.addRange', 'marker.addSubclip', 'marker.addCart', '-', 'marker.rename', 'marker.merge', 'marker.convertRange', '-', 'marker.deleteSelected', 'marker.deleteAll', '-', 'marker.previous', 'marker.next'] },
      { label: 'Zero Crossings', submenu: ['zero.inward', 'zero.outward', '-', 'zero.leftToLeft', 'zero.leftToRight', 'zero.rightToLeft', 'zero.rightToRight'] },
      { label: 'Snapping', submenu: ['edit.snapping', '-', 'snap.markers', 'snap.ruler', 'snap.rulerFine', 'snap.clips', 'snap.loops', 'snap.zero', 'snap.frames'] },
      '-',
      'window.batch',
      'edit.extractChannels',
      'edit.bandSplitter',
      '-',
      'edit.convertSampleType',
      'edit.interpretRate',
      '-',
      'edit.editOriginal',
      '-',
      'edit.keyboardShortcuts',
      'edit.preferences',
    ],
  },
  {
    label: 'Multitrack',
    submenu: [
      { label: 'Tracks', submenu: ['mt.addMono', 'mt.addStereo', 'mt.add51', '-', 'mt.addMonoBus', 'mt.addBus', 'mt.add51Bus', '-', 'mt.addVideoTrack', '-', 'mt.addTracks', '-', 'mt.duplicateTrack', 'mt.deleteTrack', 'mt.deleteEmpty', '-', 'mt.moveTrackUp', 'mt.moveTrackDown', 'mt.trackColor'] },
      'mt.insertFiles',
      { label: 'Video', submenu: ['video.toPlayhead', 'video.toStart', 'video.lock', '-', 'video.remove'] },
      '-',
      { label: 'Bounce to New Track', submenu: ['mt.bounceTrack', 'mt.bounceTime', 'mt.bounceClipsInTime', 'mt.bounceClips'] },
      { label: 'Mixdown Session to New File', submenu: ['mt.mixdownAll', 'mt.mixdownTime', 'mt.mixdownClips'] },
      '-',
      {
        label: 'Metronome',
        submenu: [
          'mt.metronome',
          'mt.metronomePattern',
          {
            label: 'Change Sound Type',
            submenu: ['mt.metronomeSoundBeep', 'mt.metronomeSoundWoodblock', 'mt.metronomeSoundClave', 'mt.metronomeSoundCowbell', 'mt.metronomeSoundHihat', 'mt.metronomeSoundRimshot', 'mt.metronomeSoundShaker', 'mt.metronomeSoundSticks', 'mt.metronomeSoundKit', 'mt.metronomeSoundTick'],
          },
        ],
      },
      'mt.clipKeyframes',
      '-',
      { label: 'Track Visibility', submenu: ['mt.visibilityMixer', '-', ...VISIBILITY_MENU, '-', 'mt.minimizeTrack'] },
      'mt.sessionProperties',
    ],
  },
  {
    label: 'Clip',
    submenu: [
      'clip.editSource',
      'clip.rename',
      '-',
      'clip.split',
      'clip.splitAll',
      'clip.merge',
      'clip.uniqueCopy',
      'clip.silenceTime',
      'clip.speechAlign',
      'clip.trimToSelection',
      'clip.trimInToPlayhead',
      'clip.trimOutToPlayhead',
      '-',
      'clip.lock',
      'clip.loop',
      'clip.mute',
      '-',
      'clip.gain',
      'clip.matchLoudness',
      { label: 'Fade In', submenu: ['clip.fadeInNone', 'clip.fadeInOn', 'clip.fadeInCrossfade', '-', 'clip.crossfadeSymmetric', 'clip.crossfadeAsymmetric', '-', 'clip.fadeInLinear', 'clip.fadeInLog', 'clip.fadeInCosine'] },
      { label: 'Fade Out', submenu: ['clip.fadeOutNone', 'clip.fadeOutOn', 'clip.fadeOutCrossfade', '-', 'clip.crossfadeSymmetric', 'clip.crossfadeAsymmetric', '-', 'clip.fadeOutLinear', 'clip.fadeOutLog', 'clip.fadeOutCosine'] },
      'clip.autoCrossfade',
      '-',
      { label: 'Groups', submenu: ['clip.group', 'clip.suspendGroups', 'clip.removeFromGroup', 'clip.ungroup'] },
      {
        label: 'Stretch',
        submenu: ['clip.globalStretch', 'clip.realtimeAll', 'clip.renderAll', '-', { label: 'Stretch Mode', submenu: ['clip.stretchModeOff', 'clip.stretchModeRealtime', 'clip.stretchModeRendered'] }, 'clip.stretch'],
      },
      { label: 'Remix', submenu: ['clip.remixEnable', 'clip.remixProperties', '-', 'clip.remixSplit', 'clip.remixRevert'] },
      '-',
      'clip.bringToFront',
      'clip.sendToBack',
      'clip.color',
      '-',
      'clip.nudgeLeft',
      'clip.nudgeRight',
      'clip.nudgeUp',
      'clip.nudgeDown',
      '-',
      'clip.revealInFiles',
      'clip.linkMedia',
    ],
  },
  {
    label: 'Effects',
    submenu: [
      'fx.showRack',
      'fx.editClipEffects',
      'fx.editTrackEffects',
      '-',
      'fx.invert',
      'fx.reverse',
      'fx.silence',
      'fx.dcOffset',
      '-',
      { label: 'Generate', submenu: ['gen.noise', 'gen.speech', 'gen.tones', 'gen.silence'] },
      'fx.matchLoudness',
      '-',
      { expand: effectMenuSpec },
      '-',
      'fx.applyLast',
    ],
  },
  {
    label: 'Favorites',
    submenu: [{ label: 'Apply', items: (app) => app.favoriteMenuItems?.() || [] }, '-', 'fav.add', 'fav.delete', 'fav.edit', '-', 'fav.recordStart', 'fav.recordStop'],
  },
  {
    label: 'View',
    submenu: [
      'view.multitrack',
      'view.waveform',
      '-',
      'view.spectral',
      'view.spectralPitch',
      'spectral.settings',
      { label: 'Spectral Frequency Scale', submenu: ['view.specLinear', 'view.specLog'] },
      '-',
      'view.previewEditor',
      '-',
      'view.hud',
      'view.editorControls',
      '-',
      'view.clipVolumeEnvelopes',
      'view.clipPanEnvelopes',
      'view.clipFadeHandles',
      'view.clipGainControls',
      '-',
      {
        label: 'Zoom',
        submenu: [
          'view.zoomInTime',
          'view.zoomOutTime',
          'view.zoomResetTime',
          'view.zoomInAmp',
          'view.zoomOutAmp',
          'view.zoomInFreq',
          'view.zoomOutFreq',
          '-',
          'view.zoomSelection',
          'view.zoomSelectedClips',
          'view.zoomInPoint',
          'view.zoomOutPoint',
          'view.zoomWayInPoint',
          'view.zoomWayOutPoint',
          '-',
          'view.zoomInTrack',
          'view.zoomOutTrack',
          'view.zoomOutAllTracks',
          'view.zoomFull',
          '-',
          'view.zoomPreset1',
          'view.zoomPreset2',
          'view.zoomPreset3',
          'view.zoomPreset4',
          'view.zoomPreset5',
          'view.saveZoom1',
          'view.saveZoom2',
          'view.saveZoom3',
          'view.saveZoom4',
          'view.saveZoom5',
        ],
      },
      { label: 'Time Display', items: (app) => app.timeFormatMenuItems?.() || [] },
      { label: 'Video Display', submenu: ['view.video200', 'view.video100', 'view.video50', 'view.video25', 'view.videoFit', '-', 'view.videoTimecode'] },
      { label: 'Waveform Channels', submenu: ['view.waveLayered', 'view.waveUniqueColors'] },
      '-',
      'view.scrollToPlayhead',
      'view.scrollToSelection',
      'view.autoScroll',
      '-',
      { label: 'Status Bar', submenu: ['view.statusBar', '-', 'status.cursor', 'status.frameRate', 'status.fileStatus', 'status.sampleType', 'status.size', 'status.duration', 'status.freeSpace', 'status.freeTime', 'status.dropped'] },
      {
        label: 'Metering',
        submenu: ['transport.meterInput', '-', 'meter.reset', 'meter.valleys', 'meter.gradient', 'meter.led', '-', 'meter.range120', 'meter.range96', 'meter.range72', 'meter.range60', 'meter.range48', 'meter.range24', '-', 'meter.dynamicPeaks', 'meter.staticPeaks', '-', 'meter.orientAuto', 'meter.orientHorizontal', 'meter.orientVertical'],
      },
      { label: 'Theme', submenu: ['theme.system', 'theme.light', 'theme.dark'] },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { label: 'Workspace', items: (app) => app.workspaceMenuItems?.() || [] },
      'window.maximize',
      '-',
      'window.amplitude',
      'window.batch',
      'window.diagnostics',
      'window.editor',
      'window.effects',
      'window.events',
      'window.assistant',
      'window.favorites',
      'window.files',
      'window.frequency',
      'window.history',
      'window.levels',
      'window.loudness',
      'window.markers',
      'window.media',
      'window.metadata',
      'window.mixer',
      'window.phaseAnalysis',
      'window.phase',
      'window.playlist',
      'window.properties',
      'window.selection',
      'window.time',
      'window.tools',
      'window.trackPanner',
      'window.tracks',
      'window.transport',
      'window.video',
      'window.zoom',
      '-',
      { label: 'Open Documents', items: (app) => app.documentMenuItems?.() || [] },
    ],
  },
  {
    label: 'Help',
    submenu: ['help.gettingStarted', 'help.shortcuts', '-', 'help.events', 'help.reportIssue', 'help.source', '-', 'help.about'],
  },
];

/** Waveform editor context menu (right-click / long-press on the waveform). */
export const WAVEFORM_CONTEXT = [
  'edit.cut',
  'edit.copy',
  'edit.copyToNew',
  'edit.paste',
  'edit.pasteToNew',
  'edit.mixPaste',
  'edit.delete',
  'edit.crop',
  '-',
  { label: 'Zero Crossings', submenu: ['zero.inward', 'zero.outward', '-', 'zero.leftToLeft', 'zero.leftToRight', 'zero.rightToLeft', 'zero.rightToRight'] },
  '-',
  'marker.add',
  'marker.addRange',
  '-',
  'edit.insertIntoSession',
  'file.saveSelectionAs',
  '-',
  'fx.captureNoisePrint',
  'fx.autoHeal',
  'fx.silence',
  'fx.normalize',
  'fx.amplify',
  '-',
  'edit.selectAll',
  'edit.selectView',
  'edit.deselect',
];

/** Submenu path of each command in the menu bar (top-level menu excluded), e.g. 'file.import' -> ['Import']. */
export function commandMenuPaths(menus = MENUS) {
  const out = new Map();
  const walk = (items, path) => {
    for (const it of items) {
      if (typeof it === 'string') {
        if (it !== '-' && !out.has(it)) out.set(it, path);
      } else if (it?.submenu) walk(it.submenu, [...path, it.label]);
      else if (it?.expand) walk(it.expand(null), path);
      else if (it?.id && !out.has(it.id)) out.set(it.id, path);
    }
  };
  for (const m of menus) walk(m.submenu || [], []);
  return out;
}

/**
 * A command's label with enough menu context to stand on its own in lists
 * such as Keyboard Shortcuts and command search: "Import > File" rather than
 * "File". Labels that already name their submenu, effects and top-level items
 * stay as they are.
 */
export function contextLabel(id, label, paths) {
  const base = String(label).replace(/\.\.\.$/, '');
  const path = paths.get(id);
  if (!path?.length || id.startsWith('fx.')) return base;
  const sub = path[path.length - 1];
  const first = sub.split(/\s+/)[0].toLowerCase();
  if (base.toLowerCase().includes(first)) return base;
  return `${sub} > ${base}`;
}
