// Property Editor shortcuts over constraint panels (delete, duplicate, apply) and Shift A in the
// constraint tabs.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { addConstraintMenu } from './ui';

/** The constraint panel under the mouse in a Properties editor, if any. */
function hoveredConstraint(): { constraint: string; owner: string } | null {
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y) as HTMLElement | null;
  if (!el || el.closest('input, textarea')) return null;
  const sec = el.closest<HTMLElement>('[data-con]');
  return sec ? { constraint: sec.dataset.con ?? '', owner: sec.dataset.conOwner ?? 'OBJECT' } : null;
}

const conKey = (key: string, op: string, mods: { shift?: boolean; ctrl?: boolean } = {}, extra: Record<string, unknown> = {}) => ({
  key,
  ...mods,
  action: () => {
    const c = hoveredConstraint();
    if (c) app.run(op, { ...c, ...extra });
  },
  when: () => !!hoveredConstraint(),
});

const tab = () => (app.hoverArea?.editor as { tab?: string } | undefined)?.tab;
const boneTab = () => tab() === 'BONE_CONSTRAINT';

addKeys('Property Editor', [
  conKey('X', 'constraint.delete', {}, { report: true }),
  conKey('DEL', 'constraint.delete', {}, { report: true }),
  conKey('D', 'constraint.copy', { shift: true }),
  conKey('A', 'constraint.apply', { ctrl: true }, { report: true }),
  {
    key: 'A',
    shift: true,
    menu: () => {
      const ob = app.activeObject;
      const arm = boneTab() && ob?.data ? app.doc.armatures[ob.data] : undefined;
      return addConstraintMenu(arm?.active_bone ?? undefined);
    },
    menuTitle: 'Add Constraint',
    when: () => (tab() === 'CONSTRAINT' || boneTab()) && !!app.activeObject,
  },
]);
