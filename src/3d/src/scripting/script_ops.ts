// Plain (non-interactive) duplicate operators: object.duplicate, mesh.duplicate, curve.duplicate and
// armature.duplicate copy the selection in place, as the first half of the Duplicate tools
// (which then start moving the copy). Scripts call them; F3 search finds them. A module that
// registers its own version later replaces these.
import { operators, registerOperators, type Operator } from '../app/app';

const ops: Operator[] = [];
for (const mod of ['object', 'mesh', 'curve', 'armature']) {
  const id = `${mod}.duplicate`;
  if (operators.has(id)) continue;
  const move = () => operators.get(`${mod}.duplicate_move`);
  ops.push({
    idname: id,
    label: mod === 'object' ? 'Duplicate Objects' : 'Duplicate',
    description: mod === 'object' ? 'Copy the selected objects in place' : 'Copy the selected elements in place',
    props: mod === 'object' ? [{ id: 'linked', label: 'Linked', type: 'bool', default: false }] : [],
    poll: (ctx) => !!move()?.exec && (move()!.poll?.(ctx) ?? true),
    exec: (ctx, p) => {
      const op = p.linked ? operators.get('object.duplicate_move_linked') : move();
      if (!op?.exec) return 'CANCELLED';
      return op.exec(ctx, {});
    },
  });
}
registerOperators(ops);
