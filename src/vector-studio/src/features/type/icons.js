/** Icons for the type panels: Lucide glyphs plus a few drawn on the same 24px grid. */
import { TextAlignJustifyStart, TextAlignJustifyCenter, TextAlignJustifyEnd, TextAlignJustify, Superscript, Subscript, CaseUpper, CaseLower, ListIndentIncrease, ListIndentDecrease, WholeWord, TypeOutline, ALargeSmall, ArrowUpFromLine, ArrowDownToLine } from 'lucide';
import { registerIcons } from '../../ui/icons.js';

export function registerTypeIcons() {
  registerIcons({
    'justify-left': TextAlignJustifyStart,
    'justify-center': TextAlignJustifyCenter,
    'justify-right': TextAlignJustifyEnd,
    'justify-all': TextAlignJustify,
    superscript: Superscript,
    subscript: Subscript,
    'case-upper': CaseUpper,
    'case-lower': CaseLower,
    'indent-left': ListIndentIncrease,
    'indent-right': ListIndentDecrease,
    'whole-word': WholeWord,
    'type-outline': TypeOutline,
    'small-caps': ALargeSmall,
    'space-before': ArrowUpFromLine,
    'space-after': ArrowDownToLine,
    // Original type glyphs.
    'text-language': [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z' }]],
    'font-size': [['path', { d: 'M3 19 8 6l5 13M4.8 15h6.4' }], ['path', { d: 'M15 19l3.5-9 3.5 9M16 16.5h5' }]],
    leading: [['path', { d: 'M4 6h16M4 18h16' }], ['path', { d: 'M8 15l4-7 4 7M9.3 13h5.4' }]],
    tracking: [['path', { d: 'M5 14l3-8 3 8M6 11.5h4' }], ['path', { d: 'M14 14l3-8 3 8M15 11.5h4' }], ['path', { d: 'M3 19h18M5 17l-2 2 2 2M19 17l2 2-2 2' }]],
    kerning: [['path', { d: 'M4 14l3-8 3 8M5 11.5h4' }], ['path', { d: 'M12 6l3 8 3-8' }], ['path', { d: 'M8 19h8M10 17l-2 2 2 2M14 17l2 2-2 2' }]],
    'vertical-scale': [['path', { d: 'M6 20V4M3 7l3-3 3 3M3 17l3 3 3-3' }], ['path', { d: 'M12 18l4-12 4 12M13.5 14h5' }]],
    'horizontal-scale': [['path', { d: 'M4 20h16M7 17l-3 3 3 3M17 17l3 3-3 3' }], ['path', { d: 'M8 15l4-11 4 11M9.3 11h5.4' }]],
    'baseline-shift': [['path', { d: 'M4 13l3-8 3 8M5 10.5h4' }], ['path', { d: 'M13 20l3-8 3 8M14 17.5h4' }], ['path', { d: 'M3 21h18' }]],
    'char-rotation': [['path', { d: 'M8 17l4-11 4 11M9.4 13.5h5.2' }], ['path', { d: 'M4 12a8 8 0 0 1 4-7M2.5 6.5 4 4.5l2 1.5' }]],
    'indent-first': [['path', { d: 'M10 5h10M4 10h16M4 15h16M4 20h12' }], ['path', { d: 'M4 3v4l3-2z' }]],
  });
}

// OpenType and Glyphs panels (original, 24px grid).
registerIcons({
  opentype: [['circle', { cx: '8', cy: '12', r: '5' }], ['path', { d: 'M13.5 7h7M17 7v11' }]],
  glyphs: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M12 3v18M3 12h18' }], ['path', { d: 'M5.5 9.5 7.5 5l2 4.5M6.2 8h2.6' }], ['path', { d: 'M15 18.5v-4a2 2 0 0 1 4 0' }]],
});
