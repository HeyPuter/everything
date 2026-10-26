import {
  createElement, Lock, Luggage, ListChecks, Upload, Download, Flag, CalendarClock, UserPlus, HandHelping, Weight, CheckCheck,
  Square, FileText, Palette, ListPlus, LayoutTemplate, ArrowDownUp, Bell, Users,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry.
const extra = {
  lock: Lock, luggage: Luggage, todo: ListChecks, upload: Upload, download: Download, flag: Flag, due: CalendarClock,
  assign: UserPlus, bring: HandHelping, weight: Weight, checkAll: CheckCheck, uncheckAll: Square, notes: FileText,
  palette: Palette, addList: ListPlus, template: LayoutTemplate, sort: ArrowDownUp, bell: Bell, people: Users,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
