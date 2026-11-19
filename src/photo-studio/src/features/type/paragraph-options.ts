// Type → Language Options feature sets, leading models and kashidas, and the
// Character and Paragraph panel menus: No Break, Fractional Widths, hanging
// punctuation, composers, the Justification and Hyphenation dialogs, and
// resetting character or paragraph attributes.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import {
  CLEAR,
  defaultCharStyle,
  defaultParagraphStyle,
  type CharStyle,
  type ParagraphStyle,
} from '../../imaging/text/model';
import { GLYPH_SCALING, LETTER_SPACING, WORD_SPACING } from '../../imaging/text/layout';
import { fieldChecked, fieldValue, modal } from '../files/ui';
import { applyChar, applyParagraph, focusInput, session, styleContext } from './session';
import { typeUnit } from './units';

export type TypeFeatures = 'default' | 'east-asian' | 'middle-eastern';
export const FEATURE_SETS: [TypeFeatures, string, string][] = [
  [
    'default',
    'Default Features',
    'Character and Paragraph panels show the options for Latin and similar scripts.',
  ],
  [
    'east-asian',
    'East Asian Features',
    'Also show vertical text forms and the leading model for Chinese, Japanese and Korean text.',
  ],
  [
    'middle-eastern',
    'Middle Eastern Features',
    'Also show paragraph direction, digit shapes and kashida justification for Arabic and Hebrew text.',
  ],
];
export const typeFeatures = (e: Editor): TypeFeatures => e.preferences.typeFeatures ?? 'default';

const refocus = (e: Editor) => {
  if (session) focusInput(e);
};
const char = (e: Editor): Partial<CharStyle> => styleContext(e).char;
const para = (e: Editor): Partial<ParagraphStyle> => styleContext(e).paragraph;

// Defaults of the optional character and paragraph attributes, for resets
// (absent keys would otherwise be kept by the merge).
const CHAR_RESET: Partial<CharStyle> = {
  features: '',
  digits: '',
  vertical: '',
  noBreak: false,
  wholeWidths: false,
};
const PARAGRAPH_RESET = (): Partial<ParagraphStyle> => ({
  kashida: CLEAR,
  leadingModel: CLEAR,
  composer: CLEAR,
  hanging: CLEAR,
  hyphenCapitalized: CLEAR,
  autoLeading: CLEAR,
  wordSpacing: CLEAR,
  letterSpacing: CLEAR,
  glyphScaling: CLEAR,
  hyphenMinWord: CLEAR,
  hyphenBefore: CLEAR,
  hyphenAfter: CLEAR,
  hyphenLimit: CLEAR,
  hyphenZone: CLEAR,
});

/** Justification limits and auto leading (one undo step on OK). */
async function justificationDialog(e: Editor) {
  const p = para(e);
  const row = (
    key: 'wordSpacing' | 'letterSpacing' | 'glyphScaling',
    label: string,
    dflt: number[],
    lo: number,
    hi: number,
  ) => {
    const v = p[key] ?? (p.align === undefined ? undefined : dflt);
    const cell = (i: number, name: string) =>
      `<label class="dialog-field">${name}<input name="${key}-${i}" type="number" min="${lo}" max="${hi}" step="1" value="${v ? v[i] : ''}" aria-label="${label} ${name.toLowerCase()} (%)"></label>`;
    return `<fieldset class="type-justify-row"><legend>${label} (%)</legend>${cell(0, 'Minimum')}${cell(1, 'Desired')}${cell(2, 'Maximum')}</fieldset>`;
  };
  const body = `${row('wordSpacing', 'Word spacing', WORD_SPACING, 0, 1000)}
    ${row('letterSpacing', 'Letter spacing', LETTER_SPACING, -100, 500)}
    ${row('glyphScaling', 'Glyph scaling', GLYPH_SCALING, 50, 200)}
    <label class="dialog-field">Auto leading (%)<input name="autoLeading" type="number" min="0" max="500" step="1" value="${p.autoLeading ?? (p.align === undefined ? '' : 120)}"></label>
    <p class="muted">Justified lines use the room between the minimum and maximum; every line uses the desired values. Letter spacing is a percentage of a space.</p>`;
  const result = await modal({
    title: 'Justification',
    submit: 'OK',
    className: 'type-justification',
    body,
  });
  if (!result) return refocus(e);
  const f = result.form;
  const patch: Partial<ParagraphStyle> = {};
  const triple = (
    key: 'wordSpacing' | 'letterSpacing' | 'glyphScaling',
    lo: number,
    hi: number,
  ) => {
    const v = [0, 1, 2].map((i) => Number(fieldValue(f, `${key}-${i}`)));
    if (fieldValue(f, `${key}-0`) === '' || !v.every(Number.isFinite)) return;
    const t = v.map((x) => Math.max(lo, Math.min(hi, Math.round(x))));
    // Keep minimum ≤ desired ≤ maximum.
    t[1] = Math.max(t[0], t[1]);
    t[2] = Math.max(t[1], t[2]);
    patch[key] = t;
  };
  triple('wordSpacing', 0, 1000);
  triple('letterSpacing', -100, 500);
  triple('glyphScaling', 50, 200);
  const lead = Number(fieldValue(f, 'autoLeading'));
  if (fieldValue(f, 'autoLeading') !== '' && Number.isFinite(lead))
    patch.autoLeading = Math.max(0, Math.min(500, Math.round(lead)));
  result.close();
  await applyParagraph(e, patch);
  refocus(e);
}

/** Hyphenation on or off and its rules (one undo step on OK). */
async function hyphenationDialog(e: Editor) {
  const p = para(e);
  const unit = typeUnit(e);
  const mixed = p.align === undefined;
  const num = (
    name: string,
    label: string,
    v: number | undefined,
    dflt: number,
    lo: number,
    hi: number,
    step = 1,
  ) =>
    `<label class="dialog-field">${label}<input name="${name}" type="number" min="${lo}" max="${hi}" step="${step}" value="${v ?? (mixed ? '' : dflt)}"></label>`;
  const body = `<label class="dialog-field checkbox-field">Hyphenate<input name="hyphenate" type="checkbox" ${p.hyphenate ? 'checked' : ''}></label>
    ${num('hyphenMinWord', 'Words with at least (letters)', p.hyphenMinWord, 6, 2, 25)}
    <div class="type-path-range">${num('hyphenBefore', 'Letters before a hyphen', p.hyphenBefore, 2, 1, 15)}${num('hyphenAfter', 'Letters after a hyphen', p.hyphenAfter, 3, 1, 15)}</div>
    ${num('hyphenLimit', 'Most hyphens in a row (0: no limit)', p.hyphenLimit, 0, 0, 25)}
    ${num('hyphenZone', `Hyphenation zone (${unit.suffix})`, p.hyphenZone === undefined ? undefined : Math.round(p.hyphenZone * unit.k * 100) / 100, 0, 0, 5000 * unit.k, 0.5)}
    <label class="dialog-field checkbox-field">Hyphenate capitalized words<input name="hyphenCapitalized" type="checkbox" ${p.hyphenCapitalized ? 'checked' : ''}></label>
    <p class="muted">Applies to paragraph text. In text that is not justified, a word that would start inside the zone at the end of a line moves down whole.</p>`;
  const result = await modal({
    title: 'Hyphenation',
    submit: 'OK',
    className: 'type-hyphenation',
    body,
  });
  if (!result) return refocus(e);
  const f = result.form;
  const patch: Partial<ParagraphStyle> = {
    hyphenate: fieldChecked(f, 'hyphenate'),
    hyphenCapitalized: fieldChecked(f, 'hyphenCapitalized'),
  };
  const int = (
    name: 'hyphenMinWord' | 'hyphenBefore' | 'hyphenAfter' | 'hyphenLimit',
    lo: number,
    hi: number,
  ) => {
    const raw = fieldValue(f, name);
    const v = Number(raw);
    if (raw !== '' && Number.isFinite(v)) patch[name] = Math.max(lo, Math.min(hi, Math.round(v)));
  };
  int('hyphenMinWord', 2, 25);
  int('hyphenBefore', 1, 15);
  int('hyphenAfter', 1, 15);
  int('hyphenLimit', 0, 25);
  const zone = Number(fieldValue(f, 'hyphenZone'));
  if (fieldValue(f, 'hyphenZone') !== '' && Number.isFinite(zone))
    patch.hyphenZone = Math.max(0, Math.min(5000, zone / unit.k));
  result.close();
  await applyParagraph(e, patch);
  refocus(e);
}

export function installParagraphOptions(e: Editor) {
  void e;
  for (const [set, label, description] of FEATURE_SETS)
    registerCommand({
      id: `type.features-${set}`,
      label,
      description,
      recordable: false,
      checked: (e) => typeFeatures(e) === set,
      run: (e) => {
        e.preferences.typeFeatures = set;
        e.preferencesChanged();
      },
    });
  const leading = (model: 'top' | 'bottom') => async (e: Editor) => {
    await applyParagraph(e, { leadingModel: para(e).leadingModel === model ? '' : model });
    refocus(e);
  };
  registerCommand(
    {
      id: 'type.leading-top',
      label: 'Top-to-Top Leading',
      description:
        'Measure line spacing from the top of one line to the top of the next (East Asian composition). Choose again for baseline-to-baseline spacing.',
      checked: (e) => para(e).leadingModel === 'top',
      run: leading('top'),
    },
    {
      id: 'type.leading-bottom',
      label: 'Bottom-to-Bottom Leading',
      description:
        'Measure line spacing from the bottom of one line to the bottom of the next. Choose again for baseline-to-baseline spacing.',
      checked: (e) => para(e).leadingModel === 'bottom',
      run: leading('bottom'),
    },
    {
      id: 'type.kashida',
      label: 'Kashidas',
      description:
        'Justify Arabic text by lengthening the joins between letters before widening spaces.',
      checked: (e) => para(e).kashida === true,
      run: async (e) => {
        await applyParagraph(e, { kashida: para(e).kashida !== true });
        refocus(e);
      },
    },
    {
      id: 'type.no-break',
      label: 'No Break',
      description: 'Keep the selected characters together on one line.',
      checked: (e) => char(e).noBreak === true,
      run: async (e) => {
        await applyChar(e, { noBreak: char(e).noBreak !== true });
        refocus(e);
      },
    },
    {
      id: 'type.fractional-widths',
      label: 'Fractional Widths',
      description:
        'Place characters at their exact widths. Off: each character advances by whole pixels, which can even out small text on screen.',
      checked: (e) => char(e).wholeWidths !== true,
      run: async (e) => {
        await applyChar(e, { wholeWidths: char(e).wholeWidths !== true });
        refocus(e);
      },
    },
    {
      id: 'type.reset-character',
      label: 'Reset Character',
      description:
        'Return the character attributes to the defaults, keeping the font family, style and color.',
      run: async (e) => {
        const c = char(e);
        const d = defaultCharStyle();
        const { family: _f, weight: _w, italic: _i, color: _c, ...rest } = d;
        await applyChar(e, { ...rest, ...CHAR_RESET, ...(c.family ? {} : { family: d.family }) });
        refocus(e);
      },
    },
    {
      id: 'type.hanging',
      label: 'Hanging Punctuation',
      description:
        'Let quotation marks, periods, commas and hyphens at the ends of lines hang outside the margins of paragraph text.',
      checked: (e) => para(e).hanging === true,
      run: async (e) => {
        await applyParagraph(e, { hanging: para(e).hanging !== true });
        refocus(e);
      },
    },
    {
      id: 'type.composer-single',
      label: 'Single-line Composer',
      description: 'Break paragraph text one line at a time.',
      checked: (e) => para(e).composer !== 'every-line' && para(e).align !== undefined,
      run: async (e) => {
        await applyParagraph(e, { composer: '' });
        refocus(e);
      },
    },
    {
      id: 'type.composer-every',
      label: 'Every-line Composer',
      description:
        'Choose line breaks for the whole paragraph together, for more even spacing and fewer ragged lines.',
      checked: (e) => para(e).composer === 'every-line',
      run: async (e) => {
        await applyParagraph(e, { composer: 'every-line' });
        refocus(e);
      },
    },
    {
      id: 'type.justification',
      label: 'Justification…',
      description:
        'Word spacing, letter spacing and glyph scaling limits for justified text, and auto leading.',
      run: (e) => justificationDialog(e),
    },
    {
      id: 'type.hyphenation',
      label: 'Hyphenation…',
      description: 'Turn hyphenation on and set which words break and where.',
      run: (e) => hyphenationDialog(e),
    },
    {
      id: 'type.reset-paragraph',
      label: 'Reset Paragraph',
      description: 'Return the paragraph attributes to the defaults, keeping the text direction.',
      run: async (e) => {
        const dir = para(e).direction;
        const {
          direction: _d,
          paragraphStyle: _s,
          ...rest
        } = { ...defaultParagraphStyle(), ...PARAGRAPH_RESET() };
        await applyParagraph(e, { ...rest, align: dir === 'rtl' ? 'right' : 'left' });
        refocus(e);
      },
    },
  );
}
