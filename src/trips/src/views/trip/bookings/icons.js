import {
  createElement, Plane, TrainFront, Bus, Car, CarTaxiFront, Bike, Ship, Sailboat, TramFront, Route, BedDouble, Utensils, Ticket, Flag,
  SquareParking, Bookmark, Paperclip, Link, Eye, EyeOff, ArrowUp, ArrowDown, ArrowLeftRight, CopyPlus, CircleCheck, Clock, Ban, ExternalLink,
  CalendarDays, List, CircleAlert,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

const extra = {
  flight: Plane, train: TrainFront, bus: Bus, car: Car, taxi: CarTaxiFront, bike: Bike, cruise: Ship, ferry: Sailboat, transit: TramFront,
  transport: Route, lodging: BedDouble, restaurant: Utensils, event: Ticket, tour: Flag, parking: SquareParking, other: Bookmark,
  attach: Paperclip, link: Link, eye: Eye, eyeOff: EyeOff, up: ArrowUp, down: ArrowDown, swap: ArrowLeftRight, duplicate: CopyPlus,
  confirmed: CircleCheck, pending: Clock, cancelled: Ban, external: ExternalLink, days: CalendarDays, list: List, alert: CircleAlert,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
