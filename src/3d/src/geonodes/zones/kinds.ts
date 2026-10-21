// Zone kinds: which node types form a zone, where their items live and how sockets are named.
import type { NodeData } from '../../data/types';
import { EXTEND } from './items';

export interface ItemList {
  /** props key holding the items (on the output node) */
  key: string;
  /** socket identifier prefix */
  prefix: string;
  label: string;
  /** node type and socket of the "add item" socket that extends this list */
  extend: { node: 'input' | 'output'; socket: string }[];
  /** only field-capable types (For Each Element inputs and main items) */
  fieldOnly?: boolean;
}

export interface ZoneKind {
  id: 'REPEAT' | 'SIMULATION' | 'FOREACH' | 'CLOSURE';
  label: string;
  input: string;
  output: string;
  lists: ItemList[];
  /** frame tint (rgb) */
  color: [number, number, number];
}

export const REPEAT_INPUT = 'GeometryNodeRepeatInput';
export const REPEAT_OUTPUT = 'GeometryNodeRepeatOutput';
export const SIM_INPUT = 'GeometryNodeSimulationInput';
export const SIM_OUTPUT = 'GeometryNodeSimulationOutput';
export const FOREACH_INPUT = 'GeometryNodeForeachGeometryElementInput';
export const FOREACH_OUTPUT = 'GeometryNodeForeachGeometryElementOutput';
export const BAKE = 'GeometryNodeBake';
export const CLOSURE_INPUT = 'NodeClosureInput';
export const CLOSURE_OUTPUT = 'NodeClosureOutput';

export const ZONES: ZoneKind[] = [
  {
    id: 'REPEAT',
    label: 'Repeat',
    input: REPEAT_INPUT,
    output: REPEAT_OUTPUT,
    lists: [
      {
        key: 'repeat_items',
        prefix: 'Item_',
        label: 'Repeat Items',
        extend: [
          { node: 'input', socket: EXTEND },
          { node: 'output', socket: EXTEND },
        ],
      },
    ],
    color: [103, 80, 44],
  },
  {
    id: 'SIMULATION',
    label: 'Simulation',
    input: SIM_INPUT,
    output: SIM_OUTPUT,
    lists: [
      {
        key: 'state_items',
        prefix: 'Item_',
        label: 'Simulation State',
        extend: [
          { node: 'input', socket: EXTEND },
          { node: 'output', socket: EXTEND },
        ],
      },
    ],
    color: [90, 61, 90],
  },
  {
    id: 'FOREACH',
    label: 'For Each Element',
    input: FOREACH_INPUT,
    output: FOREACH_OUTPUT,
    lists: [
      {
        key: 'input_items',
        prefix: 'Input_',
        label: 'Input Fields',
        extend: [{ node: 'input', socket: EXTEND }],
        fieldOnly: true,
      },
      {
        key: 'main_items',
        prefix: 'Main_',
        label: 'Main Geometry',
        extend: [{ node: 'output', socket: '__extend__main' }],
        fieldOnly: true,
      },
      {
        key: 'generation_items',
        prefix: 'Generation_',
        label: 'Generated Geometry',
        extend: [{ node: 'output', socket: '__extend__generation' }],
      },
    ],
    color: [53, 80, 112],
  },
  {
    id: 'CLOSURE',
    label: 'Closure',
    input: CLOSURE_INPUT,
    output: CLOSURE_OUTPUT,
    lists: [
      {
        key: 'input_items',
        prefix: 'Item_',
        label: 'Closure Inputs',
        extend: [{ node: 'input', socket: EXTEND }],
      },
      {
        key: 'output_items',
        prefix: 'Item_',
        label: 'Closure Outputs',
        extend: [{ node: 'output', socket: EXTEND }],
      },
    ],
    color: [150, 104, 52],
  },
];

export const zoneOfType = (type: string): ZoneKind | undefined => ZONES.find((z) => z.input === type || z.output === type);
export const isZoneInput = (n: NodeData) => ZONES.some((z) => z.input === n.type);
export const isZoneOutput = (n: NodeData) => ZONES.some((z) => z.output === n.type);
export const allListKeys = (z: ZoneKind) => z.lists.map((l) => l.key);
