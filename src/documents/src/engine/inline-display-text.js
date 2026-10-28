import { bodySymbolText } from './body-symbols.js';

// An atomic field still owns one source position. Its cached result can have
// several visible characters; generated page-story/shape values are already
// expanded before layout and must not be replaced with the cache again.
export function inlineDisplayText(run, text) {
  if (run?.field && run.text === '\ufffc' && text === '\ufffc') return run.field.cachedText;
  // A custom-marked note reference shows its following mark text instead of a number.
  if (run?.noteMark?.display !== undefined && text === '\ufffc') return run.noteMark.display || (run.noteMark.custom ? '\u200b' : '\u2002');
  if (run?.math && text === '\ufffc') return run.math.text;
  // A retained VML watermark is drawn behind the page, not in the line: it takes no room there.
  if (run?.vml && text === '\ufffc') return '\u200b';
  if (run?.noBreakHyphen) return text.replace('\u2011', '-');
  return bodySymbolText(run, text);
}
