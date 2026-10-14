// First-run notice that the app is an early alpha. Shown once per browser,
// dismissible, announced politely, and never blocks the interface.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

const KEY = 'music-studio:alphaNoticeSeen';

export function showAlphaNotice() {
  try {
    if (localStorage.getItem(KEY)) return null;
  } catch {
    return null;
  }
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, new Date().toISOString());
    } catch {
      // Blocked storage: the notice shows again next time, which is harmless.
    }
    node.remove();
  };
  const node = h(
    'aside.alpha-notice',
    { role: 'status', 'aria-labelledby': 'alpha-title' },
    h('span.alpha-icon', icon('triangle-alert', 18)),
    h(
      'div.alpha-body',
      h('h2#alpha-title', 'Early alpha'),
      h('p', 'Music Studio is in early development. Features will change and projects could be lost, so please do not rely on it for serious work yet. Export copies of anything important.'),
      h('div.alpha-actions', h('button.btn.sm.primary', { type: 'button', onclick: dismiss }, 'Got it')),
    ),
  );
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
  document.body.append(node);
  return node;
}
