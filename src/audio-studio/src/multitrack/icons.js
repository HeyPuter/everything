// Original glyphs for the Multitrack editor, on Lucide's 24px grid.

export const MULTITRACK_ICONS = {
  'track-io': [['path', { d: 'M3 8h10M9 4l4 4-4 4' }], ['path', { d: 'M21 16H11M15 12l-4 4 4 4' }]],
  'track-bus': [['path', { d: 'M5 4l7 8 7-8' }], ['path', { d: 'M12 12v8' }], ['path', { d: 'M8 20h8' }]],
  polarity: [['circle', { cx: '12', cy: '12', r: '6.5' }], ['path', { d: 'M5 19 19 5' }]],
  metronome: [['path', { d: 'M8.5 4h7l3.5 16H5z', 'stroke-linejoin': 'round' }], ['path', { d: 'M12 15l5-8' }], ['path', { d: 'M7 15h10' }]],
  'clip-split': [['rect', { x: '2.5', y: '7', width: '8', height: '10', rx: '1' }], ['rect', { x: '13.5', y: '7', width: '8', height: '10', rx: '1' }], ['path', { d: 'M12 3v18', 'stroke-dasharray': '2 2' }]],
  'mixer-strip': [['path', { d: 'M6 3v18M12 3v18M18 3v18' }], ['rect', { x: '4', y: '13', width: '4', height: '3', rx: '1' }], ['rect', { x: '10', y: '7', width: '4', height: '3', rx: '1' }], ['rect', { x: '16', y: '15', width: '4', height: '3', rx: '1' }]],
  // Automation lane header: step to the previous / next keyframe, add or remove one at the playhead.
  'key-prev': [['path', { d: 'M15 7l5 5-5 5-5-5z' }], ['path', { d: 'M8 7l-5 5 5 5' }]],
  'key-next': [['path', { d: 'M9 7l5 5-5 5-5-5z' }], ['path', { d: 'M16 7l5 5-5 5' }]],
  'key-toggle': [['path', { d: 'M12 4l8 8-8 8-8-8z' }], ['path', { d: 'M12 9v6M9 12h6' }]],
  // A lane wiped clean: an envelope line with a cross through its keyframe.
  'lane-clear': [['path', { d: 'M3 17h5l4-8 3 4h6' }], ['path', { d: 'M15 3l5 5M20 3l-5 5' }]],
  // Freeze (pre-render) a track: a six-armed crystal.
  freeze: [['path', { d: 'M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7' }], ['path', { d: 'M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5' }]],
  // Hold keyframe: a step.
  'key-hold': [['path', { d: 'M3 17h7V7h11' }], ['rect', { x: '8', y: '15', width: '4', height: '4' }]],
};
