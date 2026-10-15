// Properties editor panels for text objects: Text, Font (styles, underline, small caps),
// Paragraph (alignment, spacing), Transform (offset, shear) and Text Boxes.
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { panel, button, opButton, enumMenu } from '../../ui/widgets';
import { num, enumProp, splitRow } from '../../ui/props';
import { fontDataPanels } from '../../editors/properties/tabs';
import type { CurveData } from '../../data/types';
import { editFormat, textState } from './text';
import { formats, styleKey, textBoxes } from './textops';
import { FONT_SLOTS, slotKey } from './fontops';
import { openMenu } from '../../ui/menu';
import { icon } from '../../ui/icons';

/** Font data-block row: browse loaded fonts, open a file, or unlink (built-in font). */
function fontSlot(cu: CurveData, slot: string, label: string) {
  const key = slotKey(slot);
  const cur = cu[key] ? app.doc.fonts?.[cu[key] as string] : undefined;
  const assign = (id: string | null) => {
    cu[key] = id;
    changed('Assign Font');
  };
  return splitRow(
    label,
    h(
      'div',
      { class: 'id-selector' },
      h(
        'button',
        {
          class: 'ids-browse',
          'data-tip': 'Browse loaded fonts',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                { label: 'Built-in (Inter)', icon: 'font_data', active: !cur, action: () => assign(null) },
                ...Object.values(app.doc.fonts ?? {}).map((f) => ({ label: f.name, icon: 'font_data', active: f.id === cur?.id, action: () => assign(f.id) })),
              ],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('font_data'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('span', { class: 'ids-name', 'data-tip': cur?.filepath ?? 'The bundled Inter font' }, cur ? cur.name : 'Built-in'),
      h('button', { class: 'ids-btn', 'data-tip': 'Open a font file', onclick: () => app.run('font.open', { slot }) }, icon('file_folder')),
      cur ? h('button', { class: 'ids-btn', 'data-tip': 'Use the built-in font', onclick: () => app.run('font.unlink', { slot }) }, icon('x')) : null,
    ),
  );
}

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc', 'geometry');
}

/** Fill in defaults so number fields have values (older files lack these fields). */
function ensureDefaults(cu: CurveData) {
  cu.space_word ??= 1;
  cu.space_character ??= 1;
  cu.space_line ??= 1;
  cu.underline_position ??= 0;
  cu.underline_height ??= 0.05;
  cu.small_caps_scale ??= 0.75;
  cu.offset_x ??= 0;
  cu.offset_y ??= 0;
  cu.shear ??= 0;
  cu.size ??= 1;
  cu.align_x ??= 'LEFT';
  cu.align_y ??= 'TOP_BASELINE';
}

const STYLES: [string, string][] = [
  ['BOLD', 'Bold'],
  ['ITALIC', 'Italic'],
  ['UNDERLINE', 'Underline'],
  ['SMALL_CAPS', 'Small Caps'],
];

/** Whether a style is on for the selection (or for new text when nothing is selected). */
function styleOn(cu: CurveData, style: string) {
  const key = styleKey(style);
  const st = textState();
  if (st && st.anchor !== null && st.anchor !== st.caret) {
    const [a, b] = [Math.min(st.anchor, st.caret), Math.max(st.anchor, st.caret)];
    return formats(cu).slice(a, b).every((f) => !!f[key]);
  }
  return !!editFormat[key];
}

fontDataPanels.push(
  (_ob, cu) =>
    panel('cu-text', 'Text', () => [
      splitRow('Body', h('textarea', { class: 'text-body', value: cu.body ?? '', onchange: (e: Event) => ((cu.body = (e.target as HTMLTextAreaElement).value), formats(cu), changed('Edit Text')), onkeydown: (e: KeyboardEvent) => e.stopPropagation() })),
      num(cu as never, 'size' as never, 'Size', { unit: 'distance', min: 0.0001 }),
    ]),
  (_ob, cu) =>
    panel('cu-font', 'Font', () => {
      ensureDefaults(cu);
      const editing = app.doc.mode === 'EDIT';
      return [
        ...FONT_SLOTS.map(([slot, label]) => fontSlot(cu, slot, label)),
        editing
          ? splitRow(
              'Style',
              h(
                'div',
                { class: 'btn-row' },
                STYLES.map(([s, l]) => button(`cu-style-${s}`, l, () => app.run('font.style_toggle', { style: s }), { active: styleOn(cu, s), tip: `Toggle ${l.toLowerCase()} for the selection and for new text` })),
              ),
            )
          : h('div', { class: 'prop-note' }, 'Styles apply to selected text in Edit Mode (Ctrl B / I / U / P).'),
        num(cu, 'underline_position', 'Underline Position', { min: -0.2, max: 0.8 }),
        num(cu, 'underline_height', 'Underline Thickness', { min: 0, max: 0.8 }),
        num(cu, 'small_caps_scale', 'Small Caps Scale', { min: 0, max: 1, unit: 'factor' }),
      ];
    }),
  (_ob, cu) =>
    panel('cu-paragraph', 'Paragraph', () => {
      ensureDefaults(cu);
      return [
        enumProp(cu as never, 'align_x' as never, 'Alignment Horizontal', [['LEFT', 'Left'], ['CENTER', 'Center'], ['RIGHT', 'Right'], ['JUSTIFY', 'Justify'], ['FLUSH', 'Flush']]),
        enumProp(cu as never, 'align_y' as never, 'Vertical', [['TOP_BASELINE', 'Top Base-Line'], ['TOP', 'Top'], ['CENTER', 'Middle'], ['BOTTOM_BASELINE', 'Bottom Base-Line'], ['BOTTOM', 'Bottom']]),
        h('div', { class: 'sub-label' }, 'Spacing'),
        num(cu, 'space_character', 'Character', { min: 0, max: 10 }),
        num(cu, 'space_word', 'Word', { min: 0, max: 10 }),
        num(cu, 'space_line', 'Line', { min: 0, max: 10 }),
        h('div', { class: 'sub-label' }, 'Transform'),
        num(cu, 'offset_x', 'Offset X', { unit: 'distance' }),
        num(cu, 'offset_y', 'Y', { unit: 'distance' }),
        num(cu, 'shear', 'Shear', { min: -1, max: 1 }),
        splitRow(
          'Follow Curve',
          enumMenu(
            'cu-follow',
            [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.type === 'CURVE').map((o) => ({ value: o.id, label: o.name }))],
            cu.follow_curve ?? '',
            (v) => ((cu.follow_curve = v || null), changed('Follow Curve')),
          ),
        ),
      ];
    }),
  (_ob, cu) =>
    panel(
      'cu-boxes',
      'Text Boxes',
      () => {
        const boxes = textBoxes(cu);
        return [
          ...boxes.map((b, i) =>
            h(
              'div',
              { key: `box${i}`, class: 'text-box-item' },
              h('div', { class: 'sub-label' }, `Box ${i + 1}`, boxes.length > 1 ? opButton('font.textbox_remove', 'Remove', { index: i }) : null),
              num(b, 'width', 'Size X', { unit: 'distance', min: 0 }),
              num(b, 'height', 'Y', { unit: 'distance', min: 0 }),
              num(b, 'x', 'Offset X', { unit: 'distance' }),
              num(b, 'y', 'Y', { unit: 'distance' }),
            ),
          ),
          opButton('font.textbox_add', 'Add Text Box'),
          h('div', { class: 'prop-note' }, 'A box with Size X 0 does not wrap. Text flows into the next box when a box is full.'),
        ];
      },
      { closed: true },
    ),
);
