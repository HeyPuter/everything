// Node execution interface: each geometry node type registers an `exec` that reads its inputs
// lazily through an ExecContext and returns its outputs.
import type { DocumentData, NodeData, NodeTreeData, ObjectData, SocketValue } from '../data/types';
import type { Field } from './field';
import type { GeometrySet } from './geometry';
import type { FieldType } from './types';

/** Value flowing through a socket. */
export type Val = number | boolean | string | number[] | Field | GeometrySet | null | undefined;

/** Environment of one modifier evaluation. */
export interface EvalEnv {
  doc: DocumentData;
  /** object owning the modifier (Self Object) */
  ob: ObjectData | null;
  /** world matrix of the owner (column-major) */
  selfWorld: ArrayLike<number>;
  frame: number;
  fps: number;
  render: boolean;
  /** evaluated geometry of another object in its local space (Object Info) */
  objectGeometry(id: string): GeometrySet | null;
  /** world matrix of another object */
  objectWorld(id: string): ArrayLike<number> | null;
  /** objects of a collection (recursive) */
  collectionObjects(id: string): string[];
  /** cache signature of another object's state (geometry version + transform) */
  objectSig(id: string): string;
}

export interface ExecContext {
  node: NodeData;
  tree: NodeTreeData;
  env: EvalEnv;
  /** unique, deterministic path of the node (for anonymous attribute names) */
  path: string;
  prop<T extends SocketValue = SocketValue>(id: string): T;
  linked(id: string): boolean;
  /** raw input value (lazy: upstream nodes are evaluated on demand) */
  input(id: string): Val;
  geometry(id: string): GeometrySet;
  /** all geometries linked into a multi-input socket (in link order) */
  geometries(id: string): GeometrySet[];
  field(id: string, type?: FieldType): Field;
  float(id: string): number;
  int(id: string): number;
  bool(id: string): boolean;
  vector(id: string): [number, number, number];
  color(id: string): [number, number, number, number];
  string(id: string): string;
  idRef(id: string): string | null;
  matrix(id: string): number[];
  /** whether an output is linked to something */
  used(output: string): boolean;
  /** anonymous attribute name for a field output created by this node */
  anon(output: string): string;
  warn(message: string): void;
}

export interface GeoNodeExec {
  exec(ctx: ExecContext): Record<string, Val>;
  /** extra cache signature for nodes depending on state outside the tree (objects, time) */
  sig?(node: NodeData, env: EvalEnv): string;
  /** implicit field for unlinked hidden-value inputs (e.g. Position, Normal, ID) */
  implicit?: Record<string, () => Field>;
  /** node depends on scene time */
  timeDependent?: boolean;
  /** object ids this node depends on (for evaluation order) */
  deps?(node: NodeData, doc: DocumentData): string[];
}

export const geoExecs: Record<string, GeoNodeExec> = {};

export function registerExec(idname: string, e: GeoNodeExec) {
  geoExecs[idname] = e;
}
