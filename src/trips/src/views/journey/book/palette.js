// Book colors are palette names resolved in the light theme, so the page looks like paper in either app theme.
import tokensCss from '../../../styles/tokens.css?inline';
import { COLORS } from '../../../lib/book/constants.js';

let cached = null;

/** `Map<name, css color>` read from a light-stamped blank frame; empty where styles are unavailable (tests). */
export function lightPalette() {
  if (cached) return cached;
  cached = new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', inlineSize: '1px', blockSize: '1px', opacity: '0', pointerEvents: 'none', insetBlockStart: '-10px' });
    document.body.append(frame);
    const finish = () => {
      const result = new Map();
      try {
        const doc = frame.contentDocument;
        if (doc?.documentElement) {
          doc.documentElement.dataset.theme = 'light';
          const style = doc.createElement('style');
          style.textContent = tokensCss;
          doc.head.append(style);
          const computed = frame.contentWindow.getComputedStyle(doc.documentElement);
          for (const name of COLORS) {
            if (name === 'none') continue;
            const value = computed.getPropertyValue(`--${name}`).trim();
            if (value) result.set(name, value);
          }
        }
      } catch { /* sandboxed or no styles */ }
      frame.remove();
      resolve(result);
    };
    // A blank frame is ready at once in most engines; give the rest a moment.
    if (frame.contentDocument?.readyState === 'complete') finish();
    else { frame.addEventListener('load', finish, { once: true }); setTimeout(() => { if (frame.isConnected) finish(); }, 500); }
  });
  return cached;
}

/** Sets `--bk-<name>` on a node from the light palette; the stylesheet falls back to theme tokens. */
export function applyPalette(node, palette) {
  for (const [name, value] of palette ?? []) node.style.setProperty(`--bk-${name}`, value);
}

/** A CSS value for a palette name, or `transparent` for none. */
export const paint = (name, fallback = 'ink') => {
  const value = COLORS.includes(name) ? name : fallback;
  return value === 'none' ? 'transparent' : `var(--bk-${value})`;
};
