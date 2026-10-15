// Operator log for the Info editor: every finished user-level operator is recorded as the
// equivalent Python call (e.g. `bpy.ops.transform.translate(value=(1, 0, 0))`).
import { app, operators, operatorListeners, defaultProps } from '../app/app';
import { scriptState } from './rna';

export interface LogEntry {
  type: 'OPERATOR';
  message: string;
  time: number;
}

export const opLog = {
  entries: [] as LogEntry[],
  listeners: new Set<() => void>(),
};

/** Python literal for a property value. */
export function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? "float('inf')" : v < 0 ? "float('-inf')" : "float('nan')";
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(6)));
  }
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<unknown>);
    return `(${a.map(pyLiteral).join(', ')}${a.length === 1 ? ',' : ''})`;
  }
  if (v instanceof Set) return `{${[...v].map(pyLiteral).join(', ')}}`;
  if (typeof v === 'object') return `{${Object.entries(v as object).map(([k, x]) => `${pyLiteral(k)}: ${pyLiteral(x)}`).join(', ')}}`;
  return String(v);
}

/** `bpy.ops.<idname>(prop=value, …)` listing properties that differ from their defaults. */
export function formatOpCall(idname: string, props: Record<string, unknown>): string {
  const op = operators.get(idname);
  const defs = op ? defaultProps(op) : {};
  const hidden = new Set((op?.props ?? []).filter((p) => p.hidden).map((p) => p.id));
  const args: string[] = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (hidden.has(k) || v === undefined || typeof v === 'function') continue;
    if (k in defs && JSON.stringify(defs[k]) === JSON.stringify(v)) continue;
    args.push(`${k}=${pyLiteral(v)}`);
  }
  return `bpy.ops.${idname}(${args.join(', ')})`;
}

export function clearOpLog() {
  opLog.entries.length = 0;
  opLog.listeners.forEach((f) => f());
}

operatorListeners.add((idname, props) => {
  if (scriptState.depth > 0) return; // operators called from scripts are not logged
  const op = operators.get(idname);
  // the Info log records data-changing operators (plus script runs), not view navigation
  if (!op || op.internal || (op.undo === false && idname !== 'text.run_script')) return;
  opLog.entries.push({ type: 'OPERATOR', message: formatOpCall(idname, props), time: Date.now() });
  if (opLog.entries.length > 1000) opLog.entries.splice(0, opLog.entries.length - 1000);
  opLog.listeners.forEach((f) => f());
  if (typeof requestAnimationFrame === 'function') app.changed('ui');
});
