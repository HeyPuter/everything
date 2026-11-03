import { createElement, ArrowDown, ArrowUp, Split } from 'lucide';
import { icon as kitIcon } from '../../../../ui/icons.js';

// Icons the kit does not carry.
const extra = { up: ArrowUp, down: ArrowDown, split: Split };

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
