// Settings → Appearance → Text size: every px font size in the app's own CSS is multiplied by `--text-scale` at
// build time, so text grows without zooming layout. `!important` declarations (the iOS 16px input floor) stay as is.
const DECLARATION = /(?<![-\w])(font-size|font)(\s*:\s*)(\d+(?:\.\d+)?)px(?![^;{}]*!important)/g;

export function scaleFontSizes(css) {
  return css.replace(DECLARATION, (match, property, separator, size) => `${property}${separator}calc(${size}px * var(--text-scale, 1))`);
}

/** Applies to CSS under `<root>/src/` only, never to dependencies. */
export default function textScale() {
  let source = null;
  return {
    name: 'trips-text-scale',
    enforce: 'pre',
    configResolved(config) { source = `${config.root.replace(/\/$/, '')}/src/`; },
    transform(code, id) {
      const path = id.split('?')[0];
      if (!source || !path.startsWith(source) || !path.endsWith('.css')) return null;
      const scaled = scaleFontSizes(code);
      return scaled === code ? null : { code: scaled, map: null };
    },
  };
}
