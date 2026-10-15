// Proportional editing of keyframes in the Dope Sheet (frames) and Graph Editor: the O
// toggle, the falloff menu (Shift+O) and the header toggle.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators } from '../app/app';
import { addKeys } from '../app/keymap';
import { openMenu, type MenuItem } from '../ui/menu';
import { hoverEditor } from './animeditor';

type Flag = 'use_proportional_action' | 'use_proportional_fcurve';

const FALLOFFS: [string, string][] = [
  ['SMOOTH', 'Smooth'],
  ['SPHERE', 'Sphere'],
  ['ROOT', 'Root'],
  ['INVERSE_SQUARE', 'Inverse Square'],
  ['SHARP', 'Sharp'],
  ['LINEAR', 'Linear'],
  ['CONSTANT', 'Constant'],
  ['RANDOM', 'Random'],
];

/** Proportional settings for a key transform, or undefined when switched off. */
export function proportionalOf(flag: Flag): { size: number; falloff: string } | undefined {
  const ts = app.doc.scene.tool_settings;
  return ts[flag] ? { size: Math.max(0.1, ts.proportional_size || 1), falloff: ts.proportional_edit_falloff } : undefined;
}

const editorFlag = (): Flag | null => {
  const ed = hoverEditor() as unknown as { prefix?: string } | null;
  return ed?.prefix === 'graph' ? 'use_proportional_fcurve' : ed?.prefix === 'action' ? 'use_proportional_action' : null;
};

export function falloffMenu(): MenuItem[] {
  const ts = app.doc.scene.tool_settings;
  return FALLOFFS.map(([v, l]) => ({ label: l, active: ts.proportional_edit_falloff === v, op: 'anim.proportional_falloff_set', props: { falloff: v } }));
}

registerOperators([
  {
    idname: 'anim.proportional_toggle',
    label: 'Proportional Editing',
    description: 'Let unselected keys near the selection follow transforms with a falloff',
    internal: true,
    props: [{ id: 'editor', label: 'Editor', type: 'enum', default: 'GRAPH', items: [['GRAPH', 'Graph Editor'], ['ACTION', 'Dope Sheet']], hidden: true }],
    exec: (ctx, p) => {
      const flag: Flag = p.editor === 'ACTION' ? 'use_proportional_action' : 'use_proportional_fcurve';
      const ts = ctx.doc.scene.tool_settings;
      ts[flag] = !ts[flag];
    },
  },
  {
    idname: 'anim.proportional_falloff_set',
    label: 'Proportional Editing Falloff',
    description: 'Falloff curve of proportional editing',
    internal: true,
    props: [{ id: 'falloff', label: 'Falloff', type: 'enum', default: 'SMOOTH', items: FALLOFFS }],
    exec: (ctx, p) => {
      ctx.doc.scene.tool_settings.proportional_edit_falloff = p.falloff as 'SMOOTH';
    },
  },
]);

/** Header toggle + falloff dropdown. */
export function proportionalHeader(flag: Flag): Child {
  const on = !!app.doc.scene.tool_settings[flag];
  return h(
    'div',
    { key: 'prop', class: 'hdr-group' },
    h(
      'button',
      {
        class: { 'hdr-toggle': true, on },
        'data-tip': 'Proportional Editing (O)\nUnselected keys near the selection follow transforms with a falloff',
        onclick: () => app.run('anim.proportional_toggle', { editor: flag === 'use_proportional_action' ? 'ACTION' : 'GRAPH' }),
      },
      icon(on ? 'prop_on' : 'prop_off'),
    ),
    h(
      'button',
      {
        class: 'hdr-toggle',
        'data-tip': 'Proportional Editing Falloff (Shift O)',
        onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(falloffMenu(), e.currentTarget as HTMLElement, { title: 'Proportional Editing Falloff' })),
      },
      icon('smooth'),
      icon('down_arrow_hlt', 'tiny'),
    ),
  );
}

addKeys('Animation', [
  {
    key: 'O',
    action: () => {
      const f = editorFlag();
      if (f) app.run('anim.proportional_toggle', { editor: f === 'use_proportional_action' ? 'ACTION' : 'GRAPH' });
    },
    when: () => !!editorFlag(),
  },
  { key: 'O', shift: true, menu: falloffMenu, menuTitle: 'Proportional Editing Falloff', when: () => !!editorFlag() },
]);
