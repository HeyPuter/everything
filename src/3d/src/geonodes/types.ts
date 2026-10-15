// Shared types of the geometry nodes system.
import type { SocketValue } from '../data/types';

/** Attribute domains (`bpy` names). */
export type Domain = 'POINT' | 'EDGE' | 'FACE' | 'CORNER' | 'CURVE' | 'INSTANCE';

/** Attribute data types (`bpy` names; rotations are stored as XYZ Euler triples). */
export type DataType = 'FLOAT' | 'INT' | 'BOOLEAN' | 'FLOAT_VECTOR' | 'FLOAT_COLOR' | 'FLOAT2' | 'QUATERNION' | 'INT8';

/** Value types flowing through field sockets. */
export type FieldType = 'FLOAT' | 'INT' | 'BOOLEAN' | 'VECTOR' | 'RGBA' | 'ROTATION';

export type AttrArray = Float32Array | Int32Array | Uint8Array;

/** Raw socket from the generated interface data: name, identifier, type, options. */
export type GnRawSocket = [
  name: string,
  identifier: string,
  type: string,
  opts?: {
    d?: SocketValue;
    min?: number;
    max?: number;
    sub?: string;
    hv?: boolean;
    off?: boolean;
    shape?: 'DIAMOND' | 'DIAMOND_DOT';
  },
];

export interface GnRawProp {
  id: string;
  name: string;
  type: string;
  items?: [string, string][];
  d?: SocketValue;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  sub?: string;
}

export interface GnRawNode {
  label: string;
  width: number;
  description: string;
  inputs: GnRawSocket[];
  outputs: GnRawSocket[];
  props: GnRawProp[];
}

export const DOMAIN_LABELS: Record<Domain, string> = {
  POINT: 'Point',
  EDGE: 'Edge',
  FACE: 'Face',
  CORNER: 'Face Corner',
  CURVE: 'Spline',
  INSTANCE: 'Instance',
};

export const DATA_TYPE_LABELS: Record<string, string> = {
  FLOAT: 'Float',
  INT: 'Integer',
  BOOLEAN: 'Boolean',
  FLOAT_VECTOR: 'Vector',
  FLOAT_COLOR: 'Color',
  FLOAT2: '2D Vector',
  QUATERNION: 'Rotation',
  INT8: '8-Bit Integer',
};

/** Components per element of a data type. */
export function dataComps(t: DataType): number {
  switch (t) {
    case 'FLOAT_VECTOR':
    case 'QUATERNION':
      return 3;
    case 'FLOAT_COLOR':
      return 4;
    case 'FLOAT2':
      return 2;
    default:
      return 1;
  }
}

export function fieldComps(t: FieldType): number {
  return t === 'VECTOR' || t === 'ROTATION' ? 3 : t === 'RGBA' ? 4 : 1;
}

export function allocData(t: DataType, n: number): AttrArray {
  if (t === 'INT' || t === 'INT8') return new Int32Array(n);
  if (t === 'BOOLEAN') return new Uint8Array(n);
  return new Float32Array(n * dataComps(t));
}

export function fieldTypeOfData(t: DataType): FieldType {
  switch (t) {
    case 'INT':
    case 'INT8':
      return 'INT';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'FLOAT_VECTOR':
    case 'FLOAT2':
      return 'VECTOR';
    case 'FLOAT_COLOR':
      return 'RGBA';
    case 'QUATERNION':
      return 'ROTATION';
    default:
      return 'FLOAT';
  }
}

export function dataTypeOfField(t: FieldType): DataType {
  switch (t) {
    case 'INT':
      return 'INT';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'VECTOR':
      return 'FLOAT_VECTOR';
    case 'RGBA':
      return 'FLOAT_COLOR';
    case 'ROTATION':
      return 'QUATERNION';
    default:
      return 'FLOAT';
  }
}

/** Socket type of a field type. */
export function socketTypeOfField(t: FieldType): 'FLOAT' | 'INT' | 'BOOLEAN' | 'VECTOR' | 'RGBA' | 'ROTATION' {
  return t;
}

/** Node data_type enum (FLOAT, INT, FLOAT_VECTOR, FLOAT_COLOR, BOOLEAN, QUATERNION, …) to a field type. */
export function fieldTypeOfEnum(v: unknown): FieldType {
  switch (v) {
    case 'INT':
    case 'INT8':
      return 'INT';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'FLOAT_VECTOR':
    case 'VECTOR':
    case 'FLOAT2':
      return 'VECTOR';
    case 'FLOAT_COLOR':
    case 'RGBA':
    case 'BYTE_COLOR':
      return 'RGBA';
    case 'QUATERNION':
    case 'ROTATION':
      return 'ROTATION';
    default:
      return 'FLOAT';
  }
}
