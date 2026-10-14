// Menu bar structure. Items reference command ids; items whose command is not
// registered are left out, so feature modules light up their entries just by
// registering commands.
//
//   'cmd.id'                         a command
//   '-'                              separator
//   { label, submenu: [...] }        submenu of specs
//   { label, items: (app) => [...] } dynamic submenu of ready menu items
//   { expand: (app) => [...] }       ready menu items inlined when the menu opens

export const MENUS = [
  {
    label: 'File',
    items: [
      'file.new',
      { label: 'New from template', submenu: ['file.newEmpty', 'file.newStarter', 'file.newDemo'] },
      'file.open',
      'file.openLocal',
      { label: 'Open recent', items: (app) => app.recentMenuItems?.() || [] },
      '-',
      'file.save',
      'file.saveAs',
      'file.saveLocal',
      '-',
      { label: 'Import', submenu: ['file.importAudio', 'file.importMidi'] },
      { label: 'Export', submenu: ['file.exportWav', 'file.exportMidi', '-', 'file.exportStems'] },
      '-',
      'project.settings',
    ],
  },
  {
    label: 'Edit',
    items: ['edit.undo', 'edit.redo', 'view.history', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', '-', 'edit.selectAll', 'edit.deselect', 'edit.duplicate'],
  },
  {
    label: 'Add',
    items: [
      'add.synth',
      'add.drum',
      'add.sampler',
      { label: 'Instrument preset', items: (app) => app.presetMenuItems?.() || [] },
      '-',
      { label: 'Effect on selected insert', items: (app) => app.effectMenuItems?.() || [] },
      '-',
      'add.automation',
      'add.pattern',
      'add.marker',
    ],
  },
  {
    label: 'Patterns',
    items: ['patterns.new', 'patterns.nextEmpty', '-', 'patterns.rename', 'patterns.color', 'patterns.clone', 'patterns.delete', '-', 'patterns.moveUp', 'patterns.moveDown', '-', 'patterns.prev', 'patterns.next', '-', 'patterns.splitByChannel', 'patterns.transpose'],
  },
  {
    label: 'View',
    items: [
      'view.playlist',
      'view.rack',
      'view.pianoRoll',
      'view.mixer',
      'view.browser',
      '-',
      { label: 'Theme', submenu: ['theme.system', 'theme.light', 'theme.dark'] },
      'view.history',
      'view.resetLayout',
      'view.fullscreen',
    ],
  },
  {
    label: 'Options',
    items: ['options.metronome', 'options.countIn', 'options.typingKeyboard', 'options.midiInput', 'options.stepEdit', 'options.recordQuantize', 'options.autoScroll', '-', 'project.settings', 'options.audio', 'options.preferences'],
  },
  {
    label: 'Tools',
    items: ['tools.quantize', 'tools.riff', 'tools.chords', '-', 'tools.tapTempo', 'tools.stopSound', '-', 'tools.selectUnused', 'tools.purgeUnused'],
  },
  {
    label: 'Help',
    items: ['help.shortcuts', 'help.tour', '-', 'help.github', 'help.about'],
  },
];

/** Resolves a spec list to menu items (see ui/menu.js), dropping unknown commands and stray separators. */
export function buildMenuItems(app, spec) {
  const out = [];
  for (const s of spec) {
    if (s === '-') {
      out.push({ type: 'sep' });
    } else if (typeof s === 'string') {
      const it = app.commands.menuItem(s);
      if (it) out.push(it);
    } else if (s.expand) {
      out.push(...s.expand(app));
    } else if (s.submenu) {
      const items = buildMenuItems(app, s.submenu);
      if (items.some((x) => x.type !== 'sep')) out.push({ type: 'submenu', label: s.label, items });
    } else if (s.items) {
      out.push({ type: 'submenu', label: s.label, items: () => {
        const list = s.items(app);
        return list.length ? list : [{ type: 'cmd', label: 'None', enabled: false }];
      } });
    }
  }
  // Collapse separators.
  const clean = [];
  for (const it of out) {
    if (it.type === 'sep' && (!clean.length || clean.at(-1).type === 'sep')) continue;
    clean.push(it);
  }
  while (clean.at(-1)?.type === 'sep') clean.pop();
  return clean;
}

/** Every command id that appears in the menus (tests and the shortcuts list). */
export function menuCommandIds(spec = MENUS.flatMap((m) => m.items)) {
  const ids = [];
  for (const s of spec) {
    if (typeof s === 'string' && s !== '-') ids.push(s);
    else if (s?.submenu) ids.push(...menuCommandIds(s.submenu));
  }
  return ids;
}
