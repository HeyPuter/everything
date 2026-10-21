// Style module operators (View Layer ▸ Freestyle ▸ Style Modules) and their panel.
import { h, type Child } from '../ui/h';
import { app, registerOperators } from '../app/app';
import { newText } from '../data/defaults';
import { pickFile } from '../io/native';
import { panel, enumMenu, checkbox, button, opButton } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { icon } from '../ui/icons';
import { freestyleSettings } from './defaults';
import { MODULE_TEMPLATE, type FreestyleModule } from './modules';
import type { FreestyleSettings } from './types';

function modules(fs: FreestyleSettings): FreestyleModule[] {
  return (fs.modules ??= []);
}

const indexProp = { id: 'index', label: 'Index', type: 'int' as const, default: -1, min: -1, hidden: true };

/** Module an operator acts on: `index`, or the active one when -1. */
function target(p: Record<string, unknown>): { fs: FreestyleSettings; list: FreestyleModule[]; i: number } | null {
  const fs = freestyleSettings(app.doc);
  const list = modules(fs);
  const raw = Math.round(Number(p.index ?? -1));
  const i = raw >= 0 ? raw : (fs.active_module_index ?? list.length - 1);
  return list[i] ? { fs, list, i } : null;
}

function uniqueTextName(base: string): string {
  const names = new Set(Object.values(app.doc.texts).map((t) => t.name));
  if (!names.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  for (let k = 1; ; k++) {
    const n = `${stem}.${String(k).padStart(3, '0')}${ext}`;
    if (!names.has(n)) return n;
  }
}

/** Put a script into module `i` as a new text data-block. */
function assignText(i: number, name: string, body: string) {
  const fs = freestyleSettings(app.doc);
  const t = newText(uniqueTextName(name), body, 'javascript');
  app.doc.texts[t.id] = t;
  const list = modules(fs);
  if (!list[i]) list[i] = { script: null, use: true };
  list[i].script = t.id;
  return t;
}

registerOperators([
  {
    idname: 'scene.freestyle_module_add',
    label: 'Add Freestyle Module',
    description: 'Add a style module slot (a script that describes how lines are drawn) to the view layer',
    exec: () => {
      const fs = freestyleSettings(app.doc);
      const list = modules(fs);
      list.push({ script: null, use: true });
      fs.active_module_index = list.length - 1;
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.freestyle_module_remove',
    label: 'Remove Freestyle Module',
    description: 'Remove the style module from the view layer (its text stays)',
    props: [indexProp],
    poll: () => !!modules(freestyleSettings(app.doc)).length,
    exec: (_c, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      t.list.splice(t.i, 1);
      t.fs.active_module_index = Math.max(0, Math.min(t.i, t.list.length - 1));
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.freestyle_module_move',
    label: 'Move Freestyle Module',
    description: 'Move the style module up or down: modules run from top to bottom',
    props: [indexProp, { id: 'direction', label: 'Direction', type: 'enum', items: [['UP', 'Up'], ['DOWN', 'Down']], default: 'UP' }],
    exec: (_c, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      const j = t.i + (p.direction === 'DOWN' ? 1 : -1);
      if (j < 0 || j >= t.list.length) return 'CANCELLED';
      [t.list[t.i], t.list[j]] = [t.list[j], t.list[t.i]];
      t.fs.active_module_index = j;
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.freestyle_module_open',
    label: 'Open Style Module File',
    description: 'Load a style module script (JavaScript) from a file into a text data-block used by the module',
    props: [indexProp, { id: 'filepath', label: 'File Path', type: 'string', default: '' }, { id: 'make_internal', label: 'Make Internal', type: 'bool', default: true }],
    invoke: (_c, p) => {
      const i = target(p)?.i ?? -1;
      if (i < 0) {
        app.report('ERROR', 'Add a style module first');
        return 'CANCELLED';
      }
      void pickFile('.js,.mjs,.txt,text/javascript,text/plain').then(async (f) => {
        if (!f) return;
        const body = await f.text();
        assignText(i, f.name, body);
        app.pushUndo('Open Style Module File');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      // non-interactive: a text data-block with the file's name
      const t = target(p);
      const name = String(p.filepath ?? '').split(/[\\/]/).pop() ?? '';
      const text = Object.values(app.doc.texts).find((x) => x.name === name);
      if (!t || !text) {
        app.report('ERROR', `No text data-block named “${name}” (open the file interactively to load it)`);
        return 'CANCELLED';
      }
      t.list[t.i].script = text.id;
      return 'FINISHED';
    },
  },
]);

/** View Layer ▸ Freestyle ▸ Style Modules (Script control mode). */
export function styleModulesPanel(fs: FreestyleSettings): Child {
  const list = modules(fs);
  const texts = Object.values(app.doc.texts);
  const changed = (label: string) => {
    app.pushUndo(label);
    app.changed('doc');
  };
  return panel(
    'vl-fs-modules',
    'Style Modules',
    () => [
      h('div', { class: 'btn-row' }, opButton('scene.freestyle_module_add', 'Add', {}, { icon: 'add' })),
      list.length
        ? list.map((m, i) =>
            h(
              'div',
              { key: `mod-${i}`, class: { 'fs-module': true, active: i === (fs.active_module_index ?? 0) }, onpointerdown: () => ((fs.active_module_index = i), app.changed('ui')) },
              checkbox(`fs-mod-use-${i}`, '', m.use, (v) => ((m.use = v), changed(v ? 'Enable Style Module' : 'Disable Style Module')), { tip: 'Run this module' }),
              enumMenu(
                `fs-mod-text-${i}`,
                [{ value: '', label: '—' }, ...texts.map((t) => ({ value: t.id, label: t.name, icon: 'text' }))],
                m.script ?? '',
                (v) => ((m.script = v || null), changed('Style Module Script')),
                { tip: 'Text data-block with the module’s JavaScript' },
              ),
              button(`fs-mod-new-${i}`, icon('add'), () => (assignText(i, 'style_module.js', MODULE_TEMPLATE), changed('New Style Module')), { tip: 'New script from a template', className: 'fs-mod-btn' }),
              h('button', { class: 'btn fs-mod-btn', 'data-tip': 'Open a script file', onclick: () => app.run('scene.freestyle_module_open', { index: i }, { invoke: true }) }, icon('file_folder')),
              h('button', { class: 'btn fs-mod-btn', 'data-tip': 'Move up', disabled: i === 0, onclick: () => app.run('scene.freestyle_module_move', { index: i, direction: 'UP' }) }, icon('triangle_up')),
              h('button', { class: 'btn fs-mod-btn', 'data-tip': 'Move down', disabled: i === list.length - 1, onclick: () => app.run('scene.freestyle_module_move', { index: i, direction: 'DOWN' }) }, icon('triangle_down')),
              h('button', { class: 'btn fs-mod-btn', 'data-tip': 'Remove this module', onclick: () => app.run('scene.freestyle_module_remove', { index: i }) }, icon('x')),
            ),
          )
        : h('div', { class: 'prop-note' }, 'Style modules are JavaScript texts that call lines.draw({ select, style, shade }). Add a module, then create a script from the template.'),
    ],
    { sub: true },
  );
}

/** The Control Mode row of the Freestyle panel. */
export function controlModeRow(fs: FreestyleSettings): Child {
  return splitRow(
    'Control Mode',
    enumMenu(
      'fs-mode',
      [
        { value: 'EDITOR', label: 'Parameter Editor', description: 'Lines from the line sets and line styles below' },
        { value: 'SCRIPT', label: 'Script', description: 'Lines from style modules: JavaScript texts run in order' },
      ],
      fs.mode,
      (v) => {
        fs.mode = v as FreestyleSettings['mode'];
        app.pushUndo('Control Mode');
        app.changed('doc');
      },
    ),
  );
}
