import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// On a phone the status bar's "Accessibility: No issues" left the zoom controls no room and was cut off mid-word
// ("No issue"). In a sheet column of a phone's width its icon, which carries the state, stands for it; the words
// are still there for screen readers, hidden the way .visually-hidden hides text, not with display: none.
it('shows the accessibility status as its icon alone in a narrow sheet column', () => {
  const rule = declared(stylesheet('editor.css'), '.status-a11y-text', '@container sheet-column (max-width: 640px)');
  expect(rule.position).toBe('absolute');
  expect(rule.clip).toBe('rect(0, 0, 0, 0)');
  expect(rule.overflow).toBe('hidden');
  expect(rule.display).toBeUndefined();
  // Wide columns keep the words.
  expect(declared(stylesheet('editor.css'), '.status-a11y-text', false)?.position).toBeUndefined();
});
