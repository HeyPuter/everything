import {
  createElement, MapPin, Utensils, Coffee, Wine, BedDouble, Landmark, Mountain, Trees, Waves, Camera, Ticket, ShoppingBag, Music,
  Baby, Dumbbell, Church, TrainFront, Layers, Route, Maximize, WandSparkles, Navigation, ExternalLink, Star, Building2, FerrisWheel,
  Plane, Ship, Car, Bus, Bike, Footprints, TramFront, Search, ChevronUp, ChevronDown, Plus, X, Info, Map as MapIcon,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Category icons are stored as kebab-case lucide names; markers draw a subset of them.
export const MARKER_ICONS = Object.freeze({
  'map-pin': MapPin, utensils: Utensils, coffee: Coffee, wine: Wine, 'bed-double': BedDouble, landmark: Landmark, mountain: Mountain,
  trees: Trees, waves: Waves, camera: Camera, ticket: Ticket, 'shopping-bag': ShoppingBag, music: Music, baby: Baby, dumbbell: Dumbbell,
  church: Church, 'train-front': TrainFront, 'building-2': Building2, 'ferris-wheel': FerrisWheel, plane: Plane, bus: Bus,
});
const UI = {
  layers: Layers, route: Route, fit: Maximize, optimize: WandSparkles, directions: Navigation, external: ExternalLink, star: Star,
  flight: Plane, ship: Ship, car: Car, bus: Bus, bike: Bike, walk: Footprints, transit: TramFront, find: Search, up: ChevronUp,
  down: ChevronDown, add: Plus, dismiss: X, info: Info, basemap: MapIcon,
};
const draw = (component, size, attrs = {}) => createElement(component, { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon', ...attrs });

/** UI icon by name: map-specific ones here, then the kit's, then marker icons. */
export function icon(name, size = 18) {
  if (Object.hasOwn(UI, name)) return draw(UI[name], size);
  if (Object.hasOwn(MARKER_ICONS, name)) return draw(MARKER_ICONS[name], size);
  return kitIcon(name, size);
}

/** Marker glyph as an SVG element stroked in `color` (a resolved CSS color). */
export function markerGlyph(name, color, size = 24) {
  const component = MARKER_ICONS[name] ?? MapPin;
  return draw(component, size, { stroke: color, 'stroke-width': 2.4, xmlns: 'http://www.w3.org/2000/svg' });
}
