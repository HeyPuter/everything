import { el } from '../ui/dom.js';

const names = {
  bidi: 'Right-to-left paragraph layout',
  vanish: 'Hidden text',
  rPrChange: 'Tracked text-formatting changes',
  pPrChange: 'Tracked paragraph-formatting changes',
  ins: 'Tracked insertions',
  del: 'Tracked deletions',
  oMathPara: 'Display equations',
  'page story blocks not yet implemented': 'Unsupported header or footer blocks',
  mirrorMargins: 'Mirrored page margins',
  useAnsiKerningPairs: 'ANSI font kerning compatibility',
  'suppressTopSpacing line-spacing compatibility': 'First-line spacing compatibility',
  'suppressBottomSpacing line-spacing compatibility': 'Last-line spacing compatibility',
  'suppressSpacingAtTopOfPage line-spacing compatibility': 'Top-of-page spacing compatibility',
  'right-to-left gutters or vertical page text': 'Right-to-left gutters or vertical page text',
  moveFrom: 'Tracked moved text',
  moveTo: 'Tracked moved text',
  'tables with bidiVisual': 'Right-to-left table layout',
  'tables with ins': 'Tracked table-row insertions',
  'tables with del': 'Tracked table-row deletions',
  'tables with tcFitText': 'Text fitted to table-cell width',
  'tables with cell spacing': 'Spacing between table cells',
  'paragraph borders with This paragraph border style is not supported yet.': 'Paragraph border styles',
};

export function previewFeatureLabels(issues = []) {
  return [...new Set(issues.filter(issue => typeof issue === 'string' && issue.trim()).map(issue => {
    let text = issue.trim();
    // Some readers wrap another UnsupportedDocumentError. Keep its reason,
    // without repeating the generic read-only explanation inside a list item.
    for (let i = 0; i < 4; i++) {
      const cleaned = text.replace(/This document contains ([\s\S]*?), which this first editor version cannot edit yet\. The original file has not been changed\./g, '$1');
      if (cleaned === text) break;
      text = cleaned;
    }
    if (/^page borders \(/i.test(text) && text.includes('paragraph border style is not supported yet.')) return 'Page border styles';
    return names[text] || text.charAt(0).toUpperCase() + text.slice(1);
  }))];
}

export function previewNotice(pkg) {
  const features = previewFeatureLabels(pkg.previewIssues);
  return [
    el('p', {}, 'Some features are shown approximately. This document is read-only; downloads keep the original file.'),
    features.length ? el('details.preview-features', {},
      el('summary', {}, `Unsupported features detected (${features.length})`),
      el('ul', { tabindex: features.length > 8 ? 0 : null, 'aria-label': 'Unsupported features detected' }, features.map(feature => el('li', {}, feature))),
    ) : el('p', {}, 'The viewer could not identify the feature that prevented a complete preview.'),
  ];
}

export function pictureFontNotice(pkg) {
  const fonts = [...new Set(pkg.missingPictureFonts || [])];
  if (fonts.length > 4) return [el('details.preview-features', { 'data-picture-font-warning': '' },
    el('summary', {}, `Fonts unavailable in pictures (${fonts.length})`),
    el('p', {}, 'Text in those pictures may look different.'),
    el('ul', { tabindex: 0, 'aria-label': 'Fonts unavailable in pictures' }, fonts.map(font => el('li', {}, font))),
  )];
  return fonts.length ? [el('p', { 'data-picture-font-warning': '' },
    `Fonts unavailable in pictures: ${fonts.join(', ')}. Text in those pictures may look different.`)] : [];
}

export function scriptFontNotice(fonts = []) {
  const unique = [...new Set(fonts)];
  if (!unique.length) return [];
  const help = 'The font menu offers installed-font access and font-file loading.';
  if (unique.length > 4) return [el('details.preview-features', { 'data-script-font-warning': '' },
    el('summary', {}, `Approximate superscript and subscript fonts (${unique.length})`),
    el('p', {}, `Font metrics are unavailable for accurate script sizing or placement. ${help}`),
    el('ul', { tabindex: 0, 'aria-label': 'Approximate script fonts' }, unique.map(font => el('li', {}, font))),
  )];
  return [el('p', { 'data-script-font-warning': '' },
    `Superscript or subscript sizing and placement are approximate for ${unique.join(', ')}. ${help}`)];
}

/** The pictures an imported Markdown file or web page held, which the import leaves out. */
export function omittedPictureNotice(count = 0) {
  if (!count) return [];
  return [el('p', { 'data-omitted-pictures': '' },
    `${count === 1 ? 'The picture' : `The ${count.toLocaleString()} pictures`} in this file ${count === 1 ? 'was' : 'were'} not imported: pictures in Markdown and web pages are left out. Add ${count === 1 ? 'it' : 'them'} with Insert > Pictures.`)];
}
