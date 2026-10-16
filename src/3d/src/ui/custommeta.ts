// Settings of custom properties (type, limits, default, subtype, description), stored next to the
// values in the data-block's `custom_ui` record. Pure: shared by the UI and the scripting API.
type Rec = Record<string, unknown>;

export type CustomPropType = 'FLOAT' | 'INT' | 'BOOL' | 'STRING' | 'FLOAT_ARRAY' | 'INT_ARRAY' | 'BOOL_ARRAY' | 'PYTHON';

export interface CustomPropMeta {
  type?: CustomPropType;
  min?: number;
  max?: number;
  soft_min?: number;
  soft_max?: number;
  step?: number;
  precision?: number;
  subtype?: string;
  description?: string;
  default?: unknown;
}

export function customPropMeta(block: Rec, key: string): CustomPropMeta {
  return ((block.custom_ui as Record<string, CustomPropMeta> | undefined)?.[key] ?? {}) as CustomPropMeta;
}

export function setCustomPropMeta(block: Rec, key: string, meta: CustomPropMeta | null) {
  const all = ((block.custom_ui as Record<string, CustomPropMeta> | undefined) ??= {});
  if (meta) all[key] = meta;
  else delete all[key];
  if (!Object.keys(all).length) delete block.custom_ui;
}
