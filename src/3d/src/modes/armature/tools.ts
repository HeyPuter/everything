// Armature Edit Mode toolbar tools: Roll, Extrude, Extrude to Cursor.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { toolsByMode, COMMON_TOOLS } from '../../editors/view3d/toolbar';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D } from '../../editors/view3d/view3d';
import { registerIcons } from '../../ui/icons';
import { modeHandlers } from '../../ops/modes';
import { activeArmature, ensurePose } from './armature';
import type { Bone } from '../../data/types';

registerIcons({
  bone_roll: '<path class="f" d="M4 2 7 4 12 11l-1 1-7-5-2-3z" opacity=".55"/><path class="s" d="M13.5 4.5a6 6 0 0 0-6-3" fill="none" stroke-width="1.4"/><path class="f" d="M14.5 1.5v4h-4z"/>',
  bone_extrude: '<path class="f" d="M2 14 4 12l4 1-1-4 2-2-4-1z" opacity=".55"/><path class="f" d="M9 7l3-3-1-2h4v4l-2-1-3 3z"/>',
  bone_envelope: '<ellipse class="s" cx="8" cy="8" rx="6.5" ry="4" fill="none" stroke-width="1.1" stroke-dasharray="2 1.3" transform="rotate(-35 8 8)"/><path class="f" d="M4.5 11.5 6 10l5-5 .8.8-5 5L5.3 12.3z"/>',
  bone_extrude_cursor: '<path class="f" d="M2 14 4 12l4 1-1-4 2-2-4-1z" opacity=".55"/><circle class="s" cx="12" cy="4" r="2.6" fill="none" stroke-width="1.2" stroke-dasharray="1.6 1.4"/><path class="s" d="M8 8l2.2-2.2" stroke-width="1.3"/>',
});

const inArmEdit = () => app.doc.mode === 'EDIT' && !!activeArmature();

toolsByMode.EDIT_ARMATURE = [
  ...COMMON_TOOLS,
  null,
  { id: 'builtin.roll', label: 'Roll', icon: 'bone_roll', shortcut: 'Ctrl R', description: 'Roll selected bones by dragging' },
  { id: 'builtin.bone_envelope', label: 'Bone Envelope', icon: 'bone_envelope', shortcut: 'Alt S', description: 'Drag to scale the envelope distance of the selected bones' },
  null,
  { id: 'builtin.extrude', label: 'Extrude', icon: 'bone_extrude', shortcut: 'E', description: 'Extrude bones from the selected joints' },
  { id: 'builtin.extrude_to_cursor', label: 'Extrude to Cursor', icon: 'bone_extrude_cursor', description: 'Extrude a bone from the active joint to the clicked location' },
];

const ARMATURE_TOOLS = new Set(['builtin.roll', 'builtin.bone_envelope', 'builtin.extrude', 'builtin.extrude_to_cursor']);

// keep the active Edit Mode tool valid when switching between object types (mesh, armature, curve …)
const prevEnter = modeHandlers.EDIT?.enter;
modeHandlers.EDIT = {
  ...modeHandlers.EDIT,
  enter(ob) {
    const ok = prevEnter ? prevEnter(ob) : true;
    if (ok) {
      const list = (toolsByMode[`EDIT_${ob.type}`] ?? toolsByMode.EDIT).filter(Boolean);
      const ids = new Set(list.map((t) => t!.id));
      const cur = activeTools.EDIT;
      if (ob.type === 'FONT') {
        if (!ids.has(cur)) activeTools.EDIT = list[0]!.id;
      } else if (cur && (!cur.startsWith('builtin.select') || cur === 'builtin.select_text') && !ids.has(cur)) activeTools.EDIT = 'builtin.select_box';
    }
    return ok;
  },
};

registerOperators([
  {
    idname: 'armature.roll_modal',
    label: 'Roll',
    description: 'Interactively roll the selected bones around their own axis',
    poll: () => inArmEdit() && activeArmature()!.arm.bones.some((b) => b.select || b.select_head || b.select_tail),
    invoke: (ctx) => {
      const { arm } = activeArmature()!;
      const bones = arm.bones.filter((b) => b.select || (b.select_head && b.select_tail));
      if (!bones.length) return 'CANCELLED';
      const before = bones.map((b) => b.roll);
      const x0 = ctx.event?.x ?? app.pointer.x;
      let typed = '';
      let delta = 0;
      const apply = () => {
        bones.forEach((b, i) => (b.roll = before[i] + delta));
        app.changed('doc');
      };
      app.startModal({
        label: 'Roll',
        header: () => `Roll: ${typed ? typed + '|' : ((delta * 180) / Math.PI).toFixed(2) + '°'}`,
        onPointerMove(e) {
          if (typed) return;
          let deg = (e.clientX - x0) * 0.5;
          if (e.ctrlKey) deg = Math.round(deg / 5) * 5;
          delta = (deg * Math.PI) / 180;
          apply();
        },
        onPointerDown(e) {
          return e.button === 0 ? 'FINISHED' : 'CANCELLED';
        },
        onKey(e) {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter') return 'FINISHED';
          if (/^[0-9.\-]$/.test(e.key) || e.key === 'Backspace') {
            typed = e.key === 'Backspace' ? typed.slice(0, -1) : typed + e.key;
            const v = parseFloat(typed);
            delta = Number.isFinite(v) ? (v * Math.PI) / 180 : 0;
            apply();
          }
          return true;
        },
        cancel() {
          bones.forEach((b, i) => (b.roll = before[i]));
          app.changed('doc');
        },
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'armature.click_extrude',
    label: 'Extrude to Cursor',
    description: 'Create a bone from the active bone tail (or the 3D cursor) to the mouse position',
    poll: inArmEdit,
    invoke: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const { ob, arm } = activeArmature()!;
      const world = app.graph.get(ob.id)?.world ?? new Matrix4();
      const inv = world.clone().invert();
      const act = arm.bones.find((b) => b.name === arm.active_bone && b.select_tail);
      const startLocal = act ? new Vector3(...act.tail) : new Vector3(...ctx.doc.scene.cursor.location).applyMatrix4(inv);
      const r = v.el.getBoundingClientRect();
      const p = v.unproject((ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top, startLocal.clone().applyMatrix4(world)).applyMatrix4(inv);
      const base = act?.name ?? 'Bone';
      let name = base;
      for (let i = 1; arm.bones.some((b) => b.name === name); i++) name = `${base.replace(/\.\d{3}$/, '')}.${String(i).padStart(3, '0')}`;
      const nb: Bone = {
        name,
        parent: act?.name ?? null,
        head: [startLocal.x, startLocal.y, startLocal.z],
        tail: [p.x, p.y, p.z],
        roll: 0,
        use_connect: !!act,
        use_deform: true,
        use_inherit_rotation: true,
        inherit_scale: 'FULL',
        envelope_distance: 0.25,
        head_radius: 0.1,
        tail_radius: 0.05,
        bbone_segments: 1,
      };
      for (const b of arm.bones) b.select = b.select_head = b.select_tail = false;
      nb.select_tail = true;
      arm.bones.push(nb);
      arm.active_bone = nb.name;
      ensurePose(ob, arm);
      return 'FINISHED';
    },
  },
]);


editModeHooks.pointer.push((v, e) => {
  if (!inArmEdit()) return false;
  const tool = activeTools.EDIT;
  if (!ARMATURE_TOOLS.has(tool)) return false;
  if (tool === 'builtin.extrude_to_cursor') {
    if (e.shiftKey || e.ctrlKey) return false;
    app.run('armature.click_extrude', {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  // click selects, drag runs the tool
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    cleanup();
    const at = { event: { x: sx, y: sy } };
    if (tool === 'builtin.roll') app.run('transform.transform', { mode: 'BONE_ROLL', release_confirm: true }, at);
    else if (tool === 'builtin.bone_envelope') app.run('transform.transform', { mode: 'BONE_ENVELOPE_DIST', release_confirm: true }, at);
    else app.run('armature.extrude_move', {}, { event: { x: ev.clientX, y: ev.clientY } });
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});
