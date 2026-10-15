// `transform.transform` with edit-mode specific modes (curve radius, bone roll, bone envelope …).
// Other modules may already provide the operator for their own modes (e.g. the sequencer's Time
// Extend); once the app is ready we wrap whatever is registered and dispatch on `mode`.
import { onAppReady, operators, registerOperator, type OpContext, type OpResult } from '../app/app';

export interface TransformModeHandler {
  label: string;
  poll(ctx: OpContext): boolean;
  invoke(ctx: OpContext, props: Record<string, unknown>): OpResult;
  /** non-interactive run with `value` (redo panel, scripts) */
  exec(ctx: OpContext, props: Record<string, unknown>): OpResult;
}

export const transformModes: Record<string, TransformModeHandler> = {};

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const prev = operators.get('transform.transform');
  const prevItems = (prev?.props?.find((p) => p.id === 'mode')?.items ?? []) as [string, string][];
  const own = Object.entries(transformModes).map(([k, h]) => [k, h.label] as [string, string]);
  const items = [...own, ...prevItems.filter(([k]) => !transformModes[k])];
  registerOperator({
    idname: 'transform.transform',
    label: 'Transform',
    description: 'Interactively change a property of the selected elements (radius, roll, envelope …)',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: items[0]?.[0] ?? 'TIME_EXTEND', items },
      { id: 'value', label: 'Value', type: 'float', default: 0 },
      { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true },
    ],
    poll: (ctx) => Object.values(transformModes).some((h) => h.poll(ctx)) || (!!prev && (!prev.poll || prev.poll(ctx))),
    invoke: (ctx, p) => {
      const h = transformModes[p.mode as string];
      if (h) return h.poll(ctx) ? h.invoke(ctx, p) : 'CANCELLED';
      return prev?.invoke ? prev.invoke(ctx, p) : prev?.exec ? prev.exec(ctx, p) : 'CANCELLED';
    },
    exec: (ctx, p) => {
      const h = transformModes[p.mode as string];
      if (h) return h.poll(ctx) ? h.exec(ctx, p) : 'CANCELLED';
      return prev?.exec ? prev.exec(ctx, p) : 'CANCELLED';
    },
  });
}

onAppReady(install);
