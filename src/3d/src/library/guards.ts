// Keeping linked data read-only in the places that edit it outside of operator exec(): entering
// edit / paint / pose modes on linked data is refused with an explanation, and edits that hit
// read-only linked data report a clear message instead of a raw exception.
import { app, onAppReady, operators, errorDescribers, type OpContext } from '../app/app';
import type { Mode } from '../data/types';
import { isReadOnly, isReadOnlyError } from './readonly';
import { recordOf } from './core';

errorDescribers.push((e) => (isReadOnlyError(e) ? 'linked data is read-only (make it local or add a library override to change it)' : null));

/** Why the active object cannot enter a mode (null when it can). */
export function modeBlocker(mode: Mode): string | null {
  const ob = app.activeObject;
  if (!ob || mode === 'OBJECT') return null;
  if (mode === 'POSE') return isReadOnly(ob) ? `"${ob.name}" is linked: make a library override to pose it` : null;
  const data = ob.data ? recordOf(app.doc, ob.data) : undefined;
  if (isReadOnly(ob) || (data && isReadOnly(data))) return `The data of "${ob.name}" is linked and cannot be edited: make it local first (Object ▸ Relations ▸ Make Local)`;
  return null;
}

function guard(idname: string, modeOf: (ctx: OpContext, p: Record<string, unknown>) => Mode | null) {
  const op = operators.get(idname);
  if (!op) return;
  const wrap = (fn: typeof op.exec) =>
    fn &&
    ((ctx: OpContext, p: Record<string, unknown>) => {
      const mode = modeOf(ctx, p);
      const why = mode ? modeBlocker(mode) : null;
      if (why) {
        app.report('WARNING', why);
        return 'CANCELLED' as const;
      }
      return fn(ctx, p);
    });
  op.exec = wrap(op.exec);
  op.invoke = wrap(op.invoke);
}

onAppReady(() => {
  guard('object.mode_set', (ctx, p) => {
    const m = p.mode as Mode;
    return p.toggle && ctx.doc.mode === m ? null : m;
  });
  guard('object.editmode_toggle', (ctx) => (ctx.doc.mode === 'EDIT' ? null : 'EDIT'));
  guard('object.posemode_toggle', (ctx) => (ctx.doc.mode === 'POSE' ? null : 'POSE'));
});
