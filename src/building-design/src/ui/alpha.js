/**
 * First-run notice that the app is an early alpha. Shown once per browser,
 * dismissible, and never blocks the interface.
 */
import { h } from './dom.js';
import { icon } from './icons.js';

const KEY = 'bd.alphaNoticeSeen';

export function showAlphaNotice() {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
    node.remove();
  };
  const node = h(
    'aside.alpha-notice',
    { role: 'region', 'aria-label': 'Early alpha notice' },
    h('span.alpha-icon', icon('warning', 18)),
    h(
      'div.alpha-body',
      h('h2', 'Early alpha'),
      h('p', 'Building Design is in early development. Features may change and project data could be lost, so please do not rely on it for real projects yet. Keep copies of important work.'),
      h('div.alpha-actions', h('button.btn.sm.primary', { type: 'button', onClick: dismiss }, 'Got it')),
    ),
  );
  document.body.append(node);
}
