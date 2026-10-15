// Built-in transform orientations (kept in a leaf module so it can be used while other modules load).
export const BUILTIN_ORIENTATIONS = [
  ['GLOBAL', 'Global', 'orientation_global'],
  ['LOCAL', 'Local', 'orientation_local'],
  ['NORMAL', 'Normal', 'orientation_normal'],
  ['GIMBAL', 'Gimbal', 'orientation_gimbal'],
  ['VIEW', 'View', 'orientation_view'],
  ['CURSOR', 'Cursor', 'orientation_cursor'],
  ['PARENT', 'Parent', 'orientation_local'],
] as const;
