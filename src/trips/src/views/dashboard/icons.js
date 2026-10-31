import {
  createElement, LayoutGrid, List, Archive, ArchiveRestore, ArrowLeftRight, Globe, TrainFront, BedDouble, Ticket, Car, Bus, Ship,
  Utensils, Tag, LogOut, Image, Coins, CalendarClock, Hourglass,
} from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';
import { el } from '../../ui/dom.js';

const extra = {
  grid: LayoutGrid, list: List, archive: Archive, restore: ArchiveRestore, swap: ArrowLeftRight, globe: Globe, train: TrainFront,
  bed: BedDouble, ticket: Ticket, car: Car, bus: Bus, ship: Ship, utensils: Utensils, tag: Tag, leave: LogOut, image: Image,
  coins: Coins, upcoming: CalendarClock, countdown: Hourglass,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
const BY_TYPE = { flight: 'plane', train: 'train', bus: 'bus', car: 'car', taxi: 'car', bike: 'car', cruise: 'ship', ferry: 'ship', transit: 'train', transport: 'car', lodging: 'bed', restaurant: 'utensils', event: 'ticket', tour: 'ticket', parking: 'car', other: 'calendar' };
export const bookingIcon = (type, size = 16) => icon(BY_TYPE[type] ?? 'calendar', size);
/** An icon button with this view's icon set; `small` uses the compact size. */
export function iconBtn(name, label, { small = false, ...attrs } = {}) {
  return el(`button.icon-btn${small ? '.icon-btn-sm' : ''}`, { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name, small ? 16 : 18));
}
