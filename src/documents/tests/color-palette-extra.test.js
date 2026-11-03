// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { openColorPalette } from '../src/ui/color-palette.js';
import { closeMenu } from '../src/ui/menu.js';

// Choices passed as `extra` follow the reset item in the order given; each was inserted in front of the last.
afterEach(() => { closeMenu(); document.body.replaceChildren(); });
it('lists extra choices after the reset item in the order given', () => {
  const anchor = document.createElement('button'); document.body.append(anchor); anchor.focus();
  const onPick = vi.fn();
  const popup = openColorPalette({ anchor, label: 'Fill', value: 'auto', choices: [{ value: 'FF0000', label: 'Red', color: '#f00' }], reset: { value: 'auto', label: 'No fill' },
    extra: [{ value: 'foreground', label: 'Automatic foreground' }, { value: 'background', label: 'Automatic background' }, { value: 'pattern', label: 'Pattern' }], onPick });
  const labels = [...popup.menu.querySelectorAll('[role^="menuitem"]')].map(item => item.textContent.trim()).filter(text => text && !/^(Red)$/.test(text));
  expect(labels).toEqual(['No fill', 'Automatic foreground', 'Automatic background', 'Pattern']);
});
