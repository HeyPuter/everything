import {
  createElement, Undo2, Redo2, StickyNote, Sun, Moon, Clock, Coffee, Utensils, BedDouble, MapPin, Camera, Landmark, Mountain,
  Ticket, Plane, TrainFront, Bus, Car, Ship, Bike, Footprints, Luggage, Backpack, Wallet, Receipt, CalendarRange, CloudRain,
  Users, Heart, Star, Flag, Info, CircleAlert, CircleCheck, TramFront, Plug, Route, CarTaxiFront, Sailboat, SquareParking,
  Compass, Bookmark, ListPlus,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

const extra = {
  undo: Undo2, redo: Redo2, 'list-plus': ListPlus,
  // Day note icons (DAY_NOTE_ICONS in the trip schema).
  'sticky-note': StickyNote, sun: Sun, moon: Moon, clock: Clock, coffee: Coffee, utensils: Utensils, 'bed-double': BedDouble,
  'map-pin': MapPin, camera: Camera, landmark: Landmark, mountain: Mountain, ticket: Ticket, plane: Plane, 'train-front': TrainFront,
  bus: Bus, car: Car, ship: Ship, bike: Bike, footprints: Footprints, luggage: Luggage, backpack: Backpack, wallet: Wallet,
  receipt: Receipt, 'calendar-range': CalendarRange, 'cloud-rain': CloudRain, users: Users, heart: Heart, star: Star, flag: Flag,
  info: Info, 'circle-alert': CircleAlert, 'circle-check': CircleCheck,
  'tram-front': TramFront, plug: Plug, route: Route, taxi: CarTaxiFront, sailboat: Sailboat, parking: SquareParking,
  compass: Compass, bookmark: Bookmark,
};

export const MODE_ICONS = Object.freeze({ walk: 'footprints', drive: 'car', bike: 'bike', transit: 'tram-front', plugin: 'plug' });
export const RES_ICONS = Object.freeze({
  flight: 'plane', train: 'train-front', bus: 'bus', car: 'car', taxi: 'taxi', bike: 'bike', cruise: 'ship', ferry: 'sailboat',
  transit: 'tram-front', transport: 'route', lodging: 'bed-double', restaurant: 'utensils', event: 'ticket', tour: 'compass',
  parking: 'parking', other: 'bookmark',
});

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
