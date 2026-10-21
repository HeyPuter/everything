// Bone colours: each bone (and, overriding it, each pose bone) can use one of 20 colour sets or
// custom colours for its normal / selected / active states. The 3D viewport draws bone wires
// and fills in these colours when the armature's Bone Colors display option is on.
import { Color, type LineBasicMaterial, type LineSegments, type Mesh, type MeshBasicMaterial } from 'three';
import { app, registerOperators } from '../../app/app';
import type { Bone, BoneColor, Color as RGB, PoseBone } from '../../data/types';
import { drawHooks } from '../../editors/view3d/draw';
import { renderContext } from '../../render/context';
import { h, type Child } from '../../ui/h';
import { colorSwatch, enumMenu } from '../../ui/widgets';
import { activeArmature } from './armature';

export interface ColorSet {
  normal: RGB;
  select: RGB;
  active: RGB;
}

/** HSL (0..1) → linear-ish RGB triple used by the viewport materials. */
function hsl(hh: number, s: number, l: number): RGB {
  const c = new Color().setHSL(hh, s, l);
  return [c.r, c.g, c.b];
}

/** The 20 colour sets: hues around the wheel, each with a darker normal and brighter selected / active shades. */
export const BONE_COLOR_SETS: ColorSet[] = [0.0, 0.07, 0.13, 0.19, 0.28, 0.36, 0.45, 0.52, 0.58, 0.63, 0.69, 0.75, 0.81, 0.87, 0.93, 0.03, 0.1, 0.33, 0.55, 0.0].map((hue, i) => {
  const grey = i === 19;
  const s = grey ? 0 : i >= 15 ? 0.45 : 0.75;
  return { normal: hsl(hue, s, grey ? 0.35 : 0.38), select: hsl(hue, s, grey ? 0.62 : 0.6), active: hsl(hue, grey ? 0 : 0.6, 0.82) };
});

export const BONE_PALETTE_ITEMS = [
  { value: 'DEFAULT', label: 'Default Colors' },
  ...BONE_COLOR_SETS.map((_, i) => ({ value: `THEME${String(i + 1).padStart(2, '0')}`, label: `Theme Color Set ${i + 1}` })),
  { value: 'CUSTOM', label: 'Custom Color Set' },
];

/** The colours of a bone colour (null: the default bone colours). */
export function colorSetOf(c: BoneColor | undefined): ColorSet | null {
  if (!c || c.palette === 'DEFAULT') return null;
  if (c.palette === 'CUSTOM') return c.custom ?? null;
  const m = /^THEME(\d\d)$/.exec(c.palette);
  return m ? (BONE_COLOR_SETS[Number(m[1]) - 1] ?? null) : null;
}

/** The colours a bone is drawn in: the pose bone's colour when set (posed display), else the bone's. */
export function effectiveColorSet(bone: Bone | undefined, pb: PoseBone | undefined, posed: boolean): ColorSet | null {
  return (posed ? colorSetOf(pb?.color) : null) ?? colorSetOf(bone?.color);
}

export function copyBoneColor(c: BoneColor | undefined): BoneColor | undefined {
  return c ? structuredClone(c) : undefined;
}

// ---------------------------------------------------------------------------
// viewport: recolour bones before the overlay pass (the default colours are set just before)

const tmp = new Color();
drawHooks.passes.push((pass) => {
  if (pass !== 'OVERLAY' || !renderContext) return;
  const doc = app.doc;
  for (const so of renderContext.sync.objects.values()) {
    const ob = so.ev.ob;
    if (ob.type !== 'ARMATURE' || !so.bones || !ob.data) continue;
    const arm = doc.armatures[ob.data];
    if (!arm || arm.show_bone_colors === false) continue;
    const isActive = app.activeObject?.id === ob.id;
    const pose = doc.mode === 'POSE' && isActive;
    const edit = doc.mode === 'EDIT' && isActive;
    for (const c of so.bones.children) {
      const name = c.userData.bone as string | undefined;
      if (!name) continue;
      const bone = arm.bones.find((b) => b.name === name);
      const pb = ob.pose?.[name];
      const set = effectiveColorSet(bone, pb, !edit);
      if (!set) continue;
      const selected = pose ? !!pb?.select : edit ? !!bone?.select : false;
      const active = (pose || edit) && arm.active_bone === name;
      const col = active ? set.active : selected ? set.select : set.normal;
      if (c.userData.boneFill) {
        const mm = (c as Mesh).material as MeshBasicMaterial;
        // fills keep a soft tint so the wires stay readable
        tmp.setRGB(col[0], col[1], col[2]);
        mm.color.lerp(tmp, selected || active ? 0.55 : 0.4);
      } else if ((c as LineSegments).isLineSegments) {
        if (!pose && !edit && !c.userData.customShape) continue;
        ((c as LineSegments).material as LineBasicMaterial).color.setRGB(col[0], col[1], col[2]);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// properties UI (Bone tab ▸ Viewport Display) and copying colours

function colorEditor(key: string, owner: { color?: BoneColor }, label: string): Child {
  const changed = (l: string) => (app.pushUndo(l), app.changed('doc'));
  const c = owner.color ?? { palette: 'DEFAULT' };
  const custom = c.palette === 'CUSTOM' ? (c.custom ??= { normal: [0.6, 0.1, 0.1], select: [0.85, 0.3, 0.3], active: [1, 0.75, 0.75] }) : null;
  const set = colorSetOf(c);
  const row = (l: string, x: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, l), h('div', { class: 'sr-value' }, x), h('span', { class: 'decorator-space' }));
  return [
    row(
      label,
      h(
        'div',
        { class: 'bone-color-row' },
        enumMenu(`${key}-palette`, BONE_PALETTE_ITEMS, c.palette, (v) => {
          owner.color = { ...c, palette: v };
          if (v === 'DEFAULT' && !c.custom) delete owner.color;
          changed('Bone Color');
        }),
        set && !custom ? h('span', { class: 'bone-color-preview' }, [set.normal, set.select, set.active].map((x, i) => h('span', { key: i, style: { background: `rgb(${x.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})` } }))) : null,
      ),
    ),
    custom
      ? (['normal', 'select', 'active'] as const).map((k) =>
          row(
            k === 'normal' ? 'Regular' : k === 'select' ? 'Select' : 'Active',
            colorSwatch(`${key}-${k}`, custom[k], (v, final) => {
              custom[k] = [v[0], v[1], v[2]];
              app.changed('doc');
              if (final) app.pushUndo('Bone Color');
            }),
          ),
        )
      : null,
  ];
}

/** Bone tab ▸ Viewport Display: the bone colour, and in Pose Mode the pose bone colour. */
export function boneColorPanel(bone: Bone, pb: PoseBone | undefined, editing: boolean): Child {
  return [
    colorEditor(`bc-${bone.name}`, bone, 'Bone Color'),
    !editing && pb ? colorEditor(`pbc-${bone.name}`, pb, 'Pose Bone Color') : null,
  ];
}

registerOperators([
  {
    idname: 'armature.copy_bone_color_to_selected',
    label: 'Copy Colors to Selected',
    description: 'Give the selected bones the colour of the active bone',
    props: [
      {
        id: 'bone_type',
        label: 'Type',
        type: 'enum',
        default: 'EDIT',
        items: [
          ['EDIT', 'Bone', 'Copy the colours of the bone (rest / Edit Mode)'],
          ['POSE', 'Pose Bone', 'Copy the colours of the pose bone'],
        ],
      },
    ],
    poll: () => !!activeArmature()?.arm.active_bone,
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      const act = arm.bones.find((b) => b.name === arm.active_bone);
      if (!act) return 'CANCELLED';
      const pose = p.bone_type === 'POSE';
      if (pose && !ob.pose) return 'CANCELLED';
      const src = pose ? ob.pose![act.name]?.color : act.color;
      let n = 0;
      for (const b of arm.bones) {
        if (b === act) continue;
        const selected = app.doc.mode === 'POSE' ? !!ob.pose?.[b.name]?.select : !!b.select;
        if (!selected) continue;
        if (pose) {
          const pb = ob.pose![b.name];
          if (!pb) continue;
          pb.color = copyBoneColor(src);
        } else b.color = copyBoneColor(src);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
]);
