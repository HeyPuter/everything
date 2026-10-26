import { createElement, ArrowRightLeft, CircleAlert, CircleCheck, Crown, ExternalLink, Hourglass } from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry.
const extra = { transfer: ArrowRightLeft, alert: CircleAlert, done: CircleCheck, crown: Crown, open: ExternalLink, wait: Hourglass };

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
