import { createElement, CircleCheckBig, Eye, EyeOff, Flag, CalendarDays, Flame, Ticket, LandPlot, Target, Route, Earth } from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';

// Icons the kit does not carry.
const extra = { visited: CircleCheckBig, show: Eye, hide: EyeOff, flag: Flag, days: CalendarDays, streak: Flame, booking: Ticket, region: LandPlot, bucket: Target, route: Route, earth: Earth };

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': size <= 16 ? 2 : 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
