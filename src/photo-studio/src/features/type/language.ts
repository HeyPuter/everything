// Type menu: OpenType features, Font Preview Size and Language Options
// (paragraph direction and digit shapes).
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { featureOn, STYLISTIC_SETS, toggleFeature } from '../../imaging/text/feature-list';
import { ensureFeatureFont, fontFeatureSupport, stylisticSetNamesOf } from '../../imaging/text/fonts';
import type { CharStyle, ParagraphStyle } from '../../imaging/text/model';
import { applyChar, applyParagraph, focusInput, onSessionChange, session, styleContext } from './session';

const FEATURES: [string, string][] = [
  ['liga', 'Standard Ligatures'],
  ['calt', 'Contextual Alternates'],
  ['dlig', 'Discretionary Ligatures'],
  ['swsh', 'Swash'],
  ['onum', 'Oldstyle Figures'],
  ['salt', 'Stylistic Alternates'],
  ['titl', 'Titling Alternates'],
  ['ordn', 'Ordinals'],
  ['frac', 'Fractions'],
  ['jalt', 'Justification Alternates'],
  ['ornm', 'Ornaments'],
  ['smcp', 'Small Capitals'],
  ['c2sc', 'Capitals to Small Capitals'],
  ['case', 'Case-Sensitive Forms'],
  ['lnum', 'Lining Figures'],
  ['pnum', 'Proportional Figures'],
  ['tnum', 'Tabular Figures'],
  ['zero', 'Slashed Zero'],
  ['sups', 'Superscript Forms'],
  ['subs', 'Subscript Forms'],
];

export const PREVIEW_SIZES: [string, string, number][] = [
  ['none', 'None', 0],
  ['small', 'Small', 11],
  ['medium', 'Medium', 14],
  ['large', 'Large', 18],
  ['xlarge', 'Extra Large', 23],
  ['huge', 'Huge', 30],
];
// Preferences → Type → Font preview size (also in Type → Font Preview Size).
let editor: Editor | undefined;
export function fontPreviewSize(): number {
  const v = editor?.preferences.fontPreviewSize ?? 'medium';
  return PREVIEW_SIZES.find(([k]) => k === v)?.[2] ?? 14;
}

export function installLanguageCommands(e: Editor) {
  editor = e;
  // Read the font's features ahead of the menu while text is being styled.
  onSessionChange(() => {
    const c = styleContext(e).char;
    if (c.family) fontFeatureSupport(c.family, !!c.italic);
  });
  const char = (e: Editor): Partial<CharStyle> => styleContext(e).char;
  const supports = (e: Editor, tag: string) => {
    const c = char(e);
    if (!c.family) return false;
    return !!fontFeatureSupport(c.family, !!c.italic, () => e.update())?.has(tag);
  };
  const toggle = async (e: Editor, tag: string) => {
    const c = char(e);
    if (tag === 'liga') await applyChar(e, { ligatures: c.ligatures !== true });
    else {
      const features = toggleFeature(c.features, tag, !featureOn(c.features, tag));
      // Load the feature face first so the edit draws with it at once.
      if (features && c.family) await ensureFeatureFont(c.family, !!c.italic, features);
      await applyChar(e, { features });
    }
    if (session) focusInput(e);
  };
  for (const [tag, label] of FEATURES)
    registerCommand({
      id: `type.ot-${tag}`,
      label,
      description: tag === 'liga' ? undefined : 'Available when the font implements it.',
      checked: (e) => (tag === 'liga' ? char(e).ligatures === true : featureOn(char(e).features, tag)),
      enabled: (e) => tag === 'liga' || supports(e, tag),
      run: (e) => toggle(e, tag),
    });
  // Stylistic sets appear only for fonts that have them, under the names the
  // font gives them.
  STYLISTIC_SETS.forEach((tag, i) => {
    const name = () => {
      const c = editor ? char(editor) : {};
      return c.family ? stylisticSetNamesOf(c.family, !!c.italic)?.get(tag) : undefined;
    };
    registerCommand({
      id: `type.ot-${tag}`,
      get label() {
        const n = name();
        return n ? `Set ${i + 1}: ${n}` : `Stylistic Set ${i + 1}`;
      },
      menu: 'type.stylistic-sets',
      order: i,
      description: 'Alternate glyph designs the font groups as a stylistic set.',
      get hidden() {
        return !editor || !supports(editor, tag);
      },
      checked: (e) => featureOn(char(e).features, tag),
      enabled: (e) => supports(e, tag),
      run: (e) => toggle(e, tag),
    });
  });
  for (const [key, label] of PREVIEW_SIZES)
    registerCommand({
      id: `type.preview-${key}`,
      label,
      recordable: false,
      checked: () => fontPreviewSize() === PREVIEW_SIZES.find(([k]) => k === key)![2],
      run: (e) => {
        e.preferences.fontPreviewSize = key as typeof e.preferences.fontPreviewSize;
        e.preferencesChanged();
      },
    });
  const para = (e: Editor): Partial<ParagraphStyle> => styleContext(e).paragraph;
  const direction = (dir: 'ltr' | 'rtl') => async (e: Editor) => {
    const p = para(e);
    // Text starts on the reading side: flip a start alignment with the direction.
    const align = dir === 'rtl' && p.align === 'left' ? 'right' : dir === 'ltr' && p.align === 'right' ? 'left' : undefined;
    await applyParagraph(e, { direction: dir, ...(align ? { align } : {}) });
    if (session) focusInput(e);
  };
  registerCommand(
    { id: 'type.dir-ltr', label: 'Left-to-Right Text', checked: (e) => (para(e).direction ?? 'ltr') === 'ltr', run: direction('ltr'), description: 'Paragraph base direction for mixed-direction text.' },
    { id: 'type.dir-rtl', label: 'Right-to-Left Text', checked: (e) => para(e).direction === 'rtl', run: direction('rtl'), description: 'Paragraph base direction for Hebrew, Arabic and other right-to-left text.' },
  );
  // Vertical text: how Latin letters and digits stand in the column.
  const vertical = (v: '' | 'rotate' | 'combine') => async (e: Editor) => {
    await applyChar(e, { vertical: v });
    if (session) focusInput(e);
  };
  const isVertical = (e: Editor) => (session ? session.data.orientation : e.layer?.textData?.orientation) === 'vertical' || e.tool.includes('vertical');
  registerCommand(
    { id: 'type.vertical-upright', label: 'Upright Latin in Vertical Text', checked: (e) => !char(e).vertical, enabled: isVertical, run: vertical(''), description: 'Stack Latin letters and digits upright, one per cell.' },
    { id: 'type.vertical-rotate', label: 'Rotated Latin in Vertical Text', checked: (e) => char(e).vertical === 'rotate', enabled: isVertical, run: vertical('rotate'), description: 'Turn Latin letters and digits sideways so words read along the column; ideographs stay upright.' },
    { id: 'type.vertical-combine', label: 'Horizontal Short Runs in Vertical Text', checked: (e) => char(e).vertical === 'combine', enabled: isVertical, run: vertical('combine'), description: 'Set runs of up to three Latin letters or digits (dates, numbers) side by side in one cell; longer runs turn sideways.' },
  );
  const digits = (d: '' | 'arabic' | 'persian') => async (e: Editor) => {
    await applyChar(e, { digits: d });
    if (session) focusInput(e);
  };
  registerCommand(
    { id: 'type.digits-western', label: 'Western Digits (123)', checked: (e) => !char(e).digits, run: digits('') },
    { id: 'type.digits-arabic', label: 'Arabic-Indic Digits (١٢٣)', checked: (e) => char(e).digits === 'arabic', run: digits('arabic') },
    { id: 'type.digits-persian', label: 'Persian Digits (۱۲۳)', checked: (e) => char(e).digits === 'persian', run: digits('persian') },
  );
}
