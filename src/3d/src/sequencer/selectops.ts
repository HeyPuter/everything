// Timeline selection operators beyond click/box (handles, channel sides, more/less, linked,
// circle, lasso) and strip connections.
import { app, registerOperators, type Operator } from '../app/app';
import { seqList, hasEditor, hoverSeq, selectedStrips, setActive } from './context';
import { selectHandles, selectChannelSide, selectMoreLess, linkedChain, type HandleSide } from './selection';
import { connect, disconnect, withConnected, isConnected } from './connect';
import { deselectAll } from './ops';

const anySeq = () => hasEditor() && seqList().length > 0;
const anySelected = () => hasEditor() && seqList().some((s) => s.select);
const SELECT_MODES: [string, string][] = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
];

const ops: Operator[] = [
  {
    idname: 'sequencer.select_handles',
    label: 'Select Handles',
    description: 'Select handles of the selected strips, or the touching handles of their neighbors',
    props: [
      {
        id: 'side',
        label: 'Side',
        type: 'enum',
        default: 'BOTH',
        items: [
          ['LEFT', 'Left'],
          ['RIGHT', 'Right'],
          ['BOTH', 'Both'],
          ['LEFT_NEIGHBOR', 'Left Neighbor'],
          ['RIGHT_NEIGHBOR', 'Right Neighbor'],
          ['BOTH_NEIGHBORS', 'Both Neighbors'],
        ],
      },
    ],
    poll: anySelected,
    exec: (_c, p) => (selectHandles(seqList(), p.side as HandleSide) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'sequencer.select_side',
    label: 'Select Side',
    description: 'Select the strips on one side of the selected strips, in their channels',
    props: [
      {
        id: 'side',
        label: 'Side',
        type: 'enum',
        default: 'BOTH',
        items: [
          ['LEFT', 'Left'],
          ['RIGHT', 'Right'],
          ['BOTH', 'Both'],
        ],
      },
    ],
    poll: anySelected,
    exec: (_c, p) => (selectChannelSide(seqList(), p.side as 'LEFT') ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'sequencer.select_more',
    label: 'Select More',
    description: 'Also select strips touching the selection in the same channel',
    poll: anySelected,
    exec: () => (selectMoreLess(seqList(), true) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'sequencer.select_less',
    label: 'Select Less',
    description: 'Deselect the selected strips that touch an unselected strip in the same channel',
    poll: anySelected,
    exec: () => (selectMoreLess(seqList(), false) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'sequencer.select_linked',
    label: 'Select Linked',
    description: 'Select all strips chained to the selection by touching edges',
    poll: anySelected,
    exec: () => {
      const list = seqList();
      let any = false;
      while (selectMoreLess(list, true)) any = true;
      return any ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.select_linked_pick',
    label: 'Select Pick Linked',
    description: 'Select the strip under the pointer and every strip chained to it by touching edges',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: () => anySeq() && hoverSeq()?.hover === 'timeline',
    exec: (_c, p) => {
      const ed = hoverSeq();
      const s = ed?.pickStrip(app.pointer.x, app.pointer.y);
      if (!s) return 'CANCELLED';
      const list = seqList();
      if (!p.extend) deselectAll(list);
      for (const x of linkedChain(list, s)) {
        x.select = true;
        x.select_left_handle = x.select_right_handle = false;
      }
      setActive(s);
    },
  },
  {
    idname: 'sequencer.select_circle',
    label: 'Circle Select',
    description: 'Select strips by painting over them with a circle',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'ADD', items: SELECT_MODES }],
    poll: () => anySeq() && !!hoverSeq() && (hoverSeq()!.hover === 'timeline' || hoverSeq()!.hover === 'preview'),
    undo: false,
    invoke: (_c, p) => {
      hoverSeq()!.startCircle(p.mode as 'ADD');
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'sequencer.select_lasso',
    label: 'Lasso Select',
    description: 'Select strips inside a freehand shape drawn with the mouse',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    poll: () => anySeq() && !!hoverSeq() && (hoverSeq()!.hover === 'timeline' || hoverSeq()!.hover === 'preview'),
    undo: false,
    invoke: (_c, p) => {
      // the shape starts at the next press
      const mode = p.mode as 'SET';
      const down = (e: PointerEvent) => {
        removeEventListener('pointerdown', down, true);
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        hoverSeq()?.startLasso(e, mode);
      };
      addEventListener('pointerdown', down, true);
      app.report('INFO', 'Lasso Select: drag to draw the shape');
      return 'CANCELLED';
    },
  },
  // ------------------------------------------------------------------ connections
  {
    idname: 'sequencer.connect',
    label: 'Connect Strips',
    description: 'Link the selected strips so they are selected and edited together',
    props: [{ id: 'toggle', label: 'Toggle', type: 'bool', default: true }],
    poll: anySelected,
    exec: (_c, p) => {
      const list = seqList();
      const sel = selectedStrips();
      // toggle: a selection that is already one connected group gets disconnected
      if (p.toggle && sel.length > 1 && sel.every((s) => isConnected(list, s)) && withConnected(list, sel).length === sel.length) {
        disconnect(list, sel);
        return 'FINISHED';
      }
      if (sel.length < 2) {
        app.report('ERROR', 'Select at least two strips to connect');
        return 'CANCELLED';
      }
      connect(list, sel);
    },
  },
  {
    idname: 'sequencer.disconnect',
    label: 'Disconnect Strips',
    description: 'Remove the selected strips from their connections',
    poll: () => anySelected() && selectedStrips().some((s) => isConnected(seqList(), s)),
    exec: () => (disconnect(seqList(), selectedStrips()) ? 'FINISHED' : 'CANCELLED'),
  },
];

registerOperators(ops);
