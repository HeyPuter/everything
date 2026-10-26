import {
  createElement, Fuel, PlugZap, BedDouble, Coffee, Tent, Utensils, Landmark, TriangleAlert, Route, Gauge, Settings2, Car, Moon, Flag, MapPin,
  Ship, Plane, Waypoints, Hourglass, Coins, TrainFront, Bike, Footprints, TramFront, Sailboat, Mountain, Waves, Flame, Wind, CloudLightning,
  Spline, Radar, Bus, Search, Signpost,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

const own = {
  fuel: Fuel, charge: PlugZap, charging: PlugZap, rest: Coffee, camping: Tent, lodging: BedDouble, food: Utensils, sights: Landmark,
  alert: TriangleAlert, route: Route, gauge: Gauge, settings: Settings2, car: Car, night: Moon, flag: Flag, stop: MapPin, ferry: Ship, flight: Plane,
  via: Waypoints, pause: Hourglass, cost: Coins, train: TrainFront, bike: Bike, walk: Footprints, transit: TramFront, cruise: Sailboat, bus: Bus,
  EQ: Mountain, FL: Waves, WF: Flame, TC: Wind, VO: Mountain, DR: Flame, WX: CloudLightning, track: Spline, hazards: Radar, find: Search, alternatives: Signpost,
};

export function icon(name, size = 18) {
  if (!Object.hasOwn(own, name)) return kitIcon(name, size);
  return createElement(own[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}

/** Icon names per chain node kind and transport type. */
export const NODE_ICONS = Object.freeze({ visit: 'stop', booking: 'flag', stay: 'lodging', depart: 'flight', arrive: 'flight', pickup: 'car', dropoff: 'car' });
export const TRANSPORT_ICONS = Object.freeze({ flight: 'flight', train: 'train', bus: 'bus', ferry: 'ferry', cruise: 'cruise', transit: 'transit', taxi: 'car', transport: 'route' });
