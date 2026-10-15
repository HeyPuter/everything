// Node editor toolbar (T): the active tool decides what a left-button drag does — select (tweak,
// box, lasso, circle) or draw link gestures (cut, mute, add reroute). The sidebar's Tool tab
// shows the active tool's settings.
import { h, type Child } from '../../ui/h';
import { icon, registerIcons } from '../../ui/icons';
import { app } from '../../app/app';
import { panel, enumRow, numberField } from '../../ui/widgets';
import { splitRow } from '../../ui/props';

export type NodeTool = 'TWEAK' | 'SELECT_BOX' | 'SELECT_LASSO' | 'SELECT_CIRCLE' | 'LINKS_CUT' | 'LINKS_MUTE' | 'ADD_REROUTE';
export type SelectMode = 'SET' | 'ADD' | 'SUB';

registerIcons({
  node_links_cut: '<path class="s" d="M1.5 12c3 0 4-7 7-7s3.5 3 6 3" fill="none" stroke-width="1.4"/><path class="s" d="M11 1.5 5 14.5" stroke-width="1.3" stroke-dasharray="2 1.4"/>',
  node_links_mute:
    '<path class="s" d="M1.5 11c3 0 4-7 7-7s3.5 3 6 3" fill="none" stroke-width="1.4" stroke-dasharray="2.2 1.6"/><circle class="s" cx="11.5" cy="12" r="2.8" fill="none" stroke-width="1.2"/><path class="s" d="M9.5 14l4-4" stroke-width="1.2"/>',
  node_add_reroute: '<path class="s" d="M1.5 12.5c3 0 3.5-4.5 6.5-4.5s3.5-4.5 6.5-4.5" fill="none" stroke-width="1.4"/><circle class="f" cx="8" cy="8" r="2.7"/>',
});

export const NODE_TOOLS: { id: NodeTool; label: string; icon: string; tip: string }[] = [
  { id: 'TWEAK', label: 'Tweak', icon: 'select_tweak', tip: 'Click to select, drag nodes to move them' },
  { id: 'SELECT_BOX', label: 'Select Box', icon: 'select_box', tip: 'Drag a rectangle on empty space to select nodes' },
  { id: 'SELECT_LASSO', label: 'Select Lasso', icon: 'select_lasso', tip: 'Draw a freehand shape on empty space to select nodes' },
  { id: 'SELECT_CIRCLE', label: 'Select Circle', icon: 'select_circle', tip: 'Paint over nodes with a circle to select them' },
  { id: 'LINKS_CUT', label: 'Links Cut', icon: 'node_links_cut', tip: 'Drag a line across links to remove them' },
  { id: 'LINKS_MUTE', label: 'Mute Links', icon: 'node_links_mute', tip: 'Drag a line across links to mute or unmute them' },
  { id: 'ADD_REROUTE', label: 'Add Reroute', icon: 'node_add_reroute', tip: 'Drag a line across links to insert reroutes' },
];

const SELECT_TOOLS = new Set<NodeTool>(['SELECT_BOX', 'SELECT_LASSO', 'SELECT_CIRCLE']);

interface ToolEd {
  tool: NodeTool;
  selectMode: SelectMode;
  circleRadius: number;
}

export function drawToolbar(ed: ToolEd): Child {
  return NODE_TOOLS.map((t, i) => [
    i === 4 ? h('div', { key: 'sep', class: 'tb-sep' }) : null,
    h(
      'button',
      {
        key: t.id,
        class: { 'tb-tool': true, on: ed.tool === t.id },
        'data-tip': `${t.label}\n${t.tip}`,
        onclick: () => {
          ed.tool = t.id;
          app.changed('ui');
        },
      },
      icon(t.icon),
    ),
  ]);
}

/** Sidebar Tool tab: the active tool and its settings. */
export function toolTab(ed: ToolEd): Child {
  const t = NODE_TOOLS.find((x) => x.id === ed.tool) ?? NODE_TOOLS[1];
  return panel('nd-side-tool', 'Active Tool', () => [
    h('div', { class: 'nd-tool-name' }, icon(t.icon), h('span', null, t.label)),
    SELECT_TOOLS.has(t.id)
      ? splitRow(
          'Mode',
          enumRow(
            'nd-tool-mode',
            [
              { value: 'SET', label: 'Set', description: 'Replace the selection' },
              { value: 'ADD', label: 'Extend', description: 'Add to the selection' },
              { value: 'SUB', label: 'Subtract', description: 'Remove from the selection' },
            ],
            ed.selectMode,
            (v) => {
              ed.selectMode = v as SelectMode;
              app.changed('ui');
            },
          ),
        )
      : null,
    t.id === 'SELECT_CIRCLE'
      ? splitRow(
          'Radius',
          numberField({
            id: 'nd-tool-radius',
            value: ed.circleRadius,
            int: true,
            min: 5,
            max: 400,
            unit: 'pixel',
            set: (v) => {
              ed.circleRadius = v;
              app.changed('ui');
            },
          }),
        )
      : null,
    h('div', { class: 'prop-note' }, t.tip),
  ]);
}
