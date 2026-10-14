// Core commands: transport, windows, editing (routed to the active panel),
// patterns, theme and options. Feature modules register their own.

import * as E from '../model/edits.js';
import { COLORS } from '../model/project.js';
import { newProject, demoProject } from '../model/demo.js';
import { promptDialog, confirmDialog } from '../ui/dialog.js';
import { openMenu } from '../ui/menu.js';
import { REPO_URL } from '../ui/toolbar.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../instruments/presets.js';
import { applyTheme } from '../ui/theme.js';
import { IS_MAC } from '../lib/util.js';

// Cmd+Y is the browser history on macOS. The metronome is Alt+M because
// Cmd+M minimizes the window on macOS.
const REDO_KEYS = IS_MAC ? ['Mod+Shift+Z'] : ['Mod+Shift+Z', 'Mod+Y'];

/** Runs a panel action ('copy', 'paste', 'delete', ...) on the active panel, if it supports it. */
function panelAction(app, name) {
  const impl = app.shell.panels.get(app.activePanel)?.impl;
  const fn = impl?.actions?.[name];
  if (fn) fn();
  return Boolean(fn);
}
const panelHas = (app, name) => Boolean(app.shell.panels.get(app.activePanel)?.impl?.actions?.[name]);

export function registerCoreCommands(app) {
  const { commands } = app;
  const store = app.store;

  const patterns = () => store.project.patterns;
  const patIndex = () => patterns().findIndex((p) => p.id === store.view.pattern);

  commands.register(
    // ---------------------------------------------------------- transport
    { id: 'transport.play', label: 'Play / pause', keys: ['Space'], run: () => app.engine.togglePlay() },
    { id: 'transport.stop', label: 'Stop', keys: [], run: () => app.engine.stop() },
    { id: 'transport.record', label: 'Record', keys: ['R'], checked: () => app.engine.recording, run: () => app.engine.setRecording(!app.engine.recording) },
    { id: 'transport.toggleMode', label: 'Pattern / song mode', keys: ['L'], run: () => app.setMode(app.engine.mode === 'pattern' ? 'song' : 'pattern') },
    { id: 'transport.start', label: 'Go to start', keys: ['Home'], run: () => app.engine.seek(0) },

    // ---------------------------------------------------------- windows
    { id: 'view.playlist', label: 'Playlist', keys: ['F5', 'Alt+1'], checked: () => app.shell.isVisible('playlist'), run: () => app.shell.toggle('playlist') },
    { id: 'view.rack', label: 'Channel rack', keys: ['F6', 'Alt+2'], checked: () => app.shell.isVisible('rack'), run: () => app.shell.toggle('rack') },
    { id: 'view.pianoRoll', label: 'Piano roll', keys: ['F7', 'Alt+3'], checked: () => app.shell.isVisible('pianoRoll'), run: () => app.shell.toggle('pianoRoll') },
    { id: 'view.mixer', label: 'Mixer', keys: ['F9', 'Alt+4'], checked: () => app.shell.isVisible('mixer'), run: () => app.shell.toggle('mixer') },
    { id: 'view.browser', label: 'Browser', keys: ['Alt+F8', 'Alt+5'], checked: () => app.shell.isVisible('browser'), run: () => app.shell.toggle('browser') },
    {
      id: 'view.resetLayout',
      label: 'Reset window layout',
      run: () => {
        app.prefs.reset(['layout']);
        app.shell.layout();
      },
    },
    {
      id: 'view.fullscreen',
      label: 'Full screen',
      // macOS reserves F11 (show desktop); its full screen shortcut is Cmd+Ctrl+F.
      keys: [IS_MAC ? 'Mod+Ctrl+F' : 'F11'],
      enabled: () => Boolean(document.documentElement.requestFullscreen),
      checked: () => Boolean(document.fullscreenElement),
      run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
    },

    // ---------------------------------------------------------- theme
    ...['system', 'light', 'dark'].map((t) => ({
      id: `theme.${t}`,
      label: t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark',
      checked: () => app.prefs.get('theme') === t,
      run: () => {
        app.prefs.set('theme', t);
        applyTheme(t);
      },
    })),

    // ---------------------------------------------------------- edit
    { id: 'edit.undo', label: () => (store.canUndo ? `Undo ${store.undoLabel.toLowerCase()}` : 'Undo'), keys: ['Mod+Z'], enabled: () => store.canUndo, run: () => app.notify(`Undid ${store.undo()?.toLowerCase()}`) },
    { id: 'edit.redo', label: () => (store.canRedo ? `Redo ${store.redoLabel.toLowerCase()}` : 'Redo'), keys: REDO_KEYS, enabled: () => store.canRedo, run: () => app.notify(`Redid ${store.redo()?.toLowerCase()}`) },
    { id: 'edit.cut', label: 'Cut', keys: ['Mod+X'], enabled: () => panelHas(app, 'cut'), run: () => panelAction(app, 'cut') },
    { id: 'edit.copy', label: 'Copy', keys: ['Mod+C'], enabled: () => panelHas(app, 'copy'), run: () => panelAction(app, 'copy') },
    { id: 'edit.paste', label: 'Paste', keys: ['Mod+V'], enabled: () => panelHas(app, 'paste'), run: () => panelAction(app, 'paste') },
    { id: 'edit.delete', label: 'Delete', keys: ['Delete', 'Backspace'], enabled: () => panelHas(app, 'delete'), run: () => panelAction(app, 'delete') },
    { id: 'edit.selectAll', label: 'Select all', keys: ['Mod+A'], enabled: () => panelHas(app, 'selectAll'), run: () => panelAction(app, 'selectAll') },
    { id: 'edit.deselect', label: 'Deselect', keys: ['Escape'], enabled: () => panelHas(app, 'deselect'), run: () => panelAction(app, 'deselect') },
    { id: 'edit.duplicate', label: 'Duplicate', keys: ['Mod+B'], enabled: () => panelHas(app, 'duplicate'), run: () => panelAction(app, 'duplicate') },

    // ---------------------------------------------------------- patterns
    {
      id: 'patterns.new',
      label: 'New pattern',
      run: () => {
        const r = store.apply('New pattern', (p) => E.addPattern(p, { after: store.view.pattern }));
        store.setPattern(r.id);
      },
    },
    {
      id: 'patterns.nextEmpty',
      label: 'Find next empty pattern',
      keys: ['F4'],
      run: () => {
        const list = patterns();
        const i = patIndex();
        const empty = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((p) => !Object.keys(p.notes).length);
        if (empty) store.setPattern(empty.id);
        else commands.run('patterns.new');
      },
    },
    { id: 'patterns.prev', label: 'Previous pattern', keys: ['Num-'], enabled: () => patIndex() > 0, run: () => store.setPattern(patterns()[patIndex() - 1].id) },
    {
      id: 'patterns.next',
      label: 'Next pattern',
      keys: ['Num+'],
      run: () => {
        const i = patIndex();
        if (i < patterns().length - 1) store.setPattern(patterns()[i + 1].id);
        else commands.run('patterns.new');
      },
    },
    {
      id: 'patterns.rename',
      label: 'Rename pattern...',
      keys: ['F2'],
      run: async () => {
        const pat = store.pattern;
        const name = await promptDialog({ title: 'Rename pattern', label: 'Name', value: pat.name, confirm: 'Rename', validate: (v) => (v.trim() ? '' : 'Enter a name.') });
        if (name) store.apply('Rename pattern', (p) => E.updatePattern(p, pat.id, { name: name.trim().slice(0, 60) }));
      },
    },
    {
      id: 'patterns.color',
      label: 'Pattern color',
      run: () => {
        const pat = store.pattern;
        const btn = document.querySelector('.pattern-picker');
        openMenu(
          [
            { type: 'radio', label: 'Automatic', checked: !pat.color, run: () => store.apply('Pattern color', (p) => E.updatePattern(p, pat.id, { color: null })) },
            ...COLORS.map((c, i) => ({ type: 'radio', label: `Color ${i + 1}`, swatch: c, checked: pat.color === c, run: () => store.apply('Pattern color', (p) => E.updatePattern(p, pat.id, { color: c })) })),
          ],
          btn ? { anchor: btn, label: 'Pattern color' } : { x: 200, y: 60, label: 'Pattern color' },
        );
      },
    },
    {
      id: 'patterns.clone',
      label: 'Clone pattern',
      run: () => {
        const r = store.apply('Clone pattern', (p) => E.clonePattern(p, store.view.pattern));
        if (r?.id) store.setPattern(r.id);
      },
    },
    {
      id: 'patterns.delete',
      label: 'Delete pattern',
      enabled: () => patterns().length > 1,
      run: async () => {
        const pat = store.pattern;
        const used = store.project.clips.some((c) => c.kind === 'pattern' && c.ref === pat.id);
        if (used && !(await confirmDialog({ title: 'Delete pattern', message: `"${pat.name}" is used in the playlist. Delete it and its clips?`, confirm: 'Delete', danger: true }))) return;
        store.apply('Delete pattern', (p) => E.removePattern(p, pat.id));
      },
    },
    { id: 'patterns.moveUp', label: 'Move pattern up', enabled: () => patIndex() > 0, run: () => store.apply('Move pattern', (p) => E.movePattern(p, store.view.pattern, patIndex() - 1)) },
    { id: 'patterns.moveDown', label: 'Move pattern down', enabled: () => patIndex() < patterns().length - 1, run: () => store.apply('Move pattern', (p) => E.movePattern(p, store.view.pattern, patIndex() + 1)) },
    {
      id: 'patterns.splitByChannel',
      label: 'Split by channel',
      enabled: () => Object.keys(store.pattern.notes).length > 1,
      run: () => {
        const src = store.pattern;
        store.apply('Split by channel', (p) => {
          let next = p;
          for (const cid of Object.keys(src.notes)) {
            const ch = p.channels.find((c) => c.id === cid);
            const r = E.addPattern(next, { name: `${src.name} - ${ch?.name || 'Channel'}` });
            next = E.setNotes(r.project, r.id, cid, src.notes[cid].map((n) => ({ ...n })));
          }
          return next;
        });
      },
    },
    {
      id: 'patterns.transpose',
      label: 'Transpose pattern...',
      run: async () => {
        const v = await promptDialog({ title: 'Transpose pattern', label: 'Semitones (negative moves down)', value: '12', confirm: 'Transpose', validate: (s) => (Number.isInteger(Number(s)) && Math.abs(Number(s)) <= 96 ? '' : 'Enter a whole number between -96 and 96.') });
        if (v === null) return;
        const st = Number(v);
        const pat = store.pattern;
        store.apply('Transpose pattern', (p) => {
          let next = p;
          for (const [cid, list] of Object.entries(pat.notes)) next = E.setNotes(next, pat.id, cid, list.map((n) => ({ ...n, key: Math.max(0, Math.min(127, n.key + st)) })));
          return next;
        });
      },
    },

    // ---------------------------------------------------------- add
    ...Object.entries({ synth: 'Poly Synth', drum: 'Drum Synth', sampler: 'Sampler' }).map(([type, label]) => ({
      id: `add.${type}`,
      label: `Add ${label}`,
      run: () => app.addChannel({ type, name: label }),
    })),
    { id: 'add.pattern', label: 'Add pattern', run: () => commands.run('patterns.new') },

    // ---------------------------------------------------------- options
    { id: 'options.metronome', label: 'Metronome', keys: ['Alt+M'], checked: () => app.prefs.get('metronome'), run: () => app.prefs.toggle('metronome') },
    { id: 'options.countIn', label: 'Count-in before recording', keys: ['Mod+P'], checked: () => app.prefs.get('countIn'), run: () => app.prefs.toggle('countIn') },
    { id: 'options.typingKeyboard', label: 'Typing keyboard to piano', keys: ['Alt+K'], checked: () => app.prefs.get('typingKeyboard'), run: () => app.prefs.toggle('typingKeyboard') },
    { id: 'options.stepEdit', label: 'Step edit', keys: ['Mod+E'], checked: () => app.prefs.get('stepEditing'), run: () => app.prefs.toggle('stepEditing') },
    { id: 'options.autoScroll', label: 'Auto scroll', checked: () => app.prefs.get('autoScroll'), run: () => app.prefs.toggle('autoScroll') },

    // ---------------------------------------------------------- tools
    { id: 'tools.stopSound', label: 'Stop all sound', keys: ['Mod+.'], run: () => app.engine.allNotesOff() },
    {
      id: 'tools.selectUnused',
      label: 'Select unused channels',
      run: () => {
        const used = new Set(store.project.patterns.flatMap((p) => Object.keys(p.notes)));
        for (const c of store.project.clips) if (c.kind === 'audio') used.add(c.ref);
        const ids = store.project.channels.filter((c) => !used.has(c.id)).map((c) => c.id);
        store.selectChannels(ids);
        app.notify(ids.length ? `${ids.length} unused channel${ids.length === 1 ? '' : 's'} selected` : 'Every channel is used');
      },
    },

    // ---------------------------------------------------------- file (in memory; storage adds the rest)
    { id: 'file.newEmpty', label: 'Empty', run: () => app.newProject(() => ({ ...newProject(), channels: [] })) },
    { id: 'file.newStarter', label: 'Starter drum kit', run: () => app.newProject(() => newProject()) },
    { id: 'file.newDemo', label: 'Demo song', run: () => app.newProject(() => demoProject()) },
    { id: 'file.new', label: 'New project', run: () => app.newProject(() => newProject()) },

    // ---------------------------------------------------------- help
    { id: 'help.github', label: 'Source code on GitHub', run: () => window.open(REPO_URL, '_blank', 'noopener') },
  );

  // Dynamic submenus.
  app.presetMenuItems = () => [
    { type: 'heading', label: 'Synth' },
    ...SYNTH_PRESETS.filter((p) => p.name !== 'Init').map((p) => ({ type: 'cmd', label: p.name, icon: 'synth', run: () => app.addChannel({ type: 'synth', name: p.name, params: p.params }) })),
    { type: 'heading', label: 'Drums' },
    ...DRUM_PRESETS.map((p) => ({ type: 'cmd', label: p.name, icon: 'drum', run: () => app.addChannel({ type: 'drum', name: p.name, params: p.params }) })),
  ];
}
