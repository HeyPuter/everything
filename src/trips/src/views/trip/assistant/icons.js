import { createElement, Sparkles, SendHorizontal, Square, MessageSquarePlus, Undo2, Settings, CircleCheck, CircleAlert, Ban, CalendarRange } from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry.
const extra = {
  sparkles: Sparkles, send: SendHorizontal, stop: Square, newChat: MessageSquarePlus, undo: Undo2, settings: Settings,
  done: CircleCheck, alert: CircleAlert, declined: Ban, dates: CalendarRange,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
