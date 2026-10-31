// Lucide icons for the editor's controls and the book's icon elements.
import {
  createElement, Plane, TrainFront, Car, Ship, Bus, Bike, Footprints, Mountain, MountainSnow, Tent, TreePalm, Trees, Sun, Sunset, Moon,
  CloudSun, Snowflake, Umbrella, Waves, Camera, MapPin, Compass, Globe, Heart, Star, Coffee, Utensils, Wine, IceCreamCone, Landmark,
  Castle, Hotel, Anchor, Sailboat, Luggage, Ticket, Music, Sparkles, Flag, Gift, Images, Type, Square, Circle, Minus, Grid2x2, Route,
  ChartColumn, Undo2, Redo2, ZoomIn, ZoomOut, Printer, Download, Upload, Lock, LockOpen, BringToFront, SendToBack, ArrowUp, ArrowDown,
  LayoutTemplate, Copy, FileUp, FileDown, BookImage, Shapes, Wand2, Earth, Maximize, PanelLeft, PanelRight, SlidersHorizontal, ImagePlus,
  Bold, Italic, AlignLeft, AlignCenter, AlignRight, Trash2, Plus, Settings, Users,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';
import { direction } from '../../../lib/i18n/index.js';

/** Element icons, by the names stored in books (see `ICONS` in lib/book/constants.js). */
export const BOOK_ICONS = Object.freeze({
  plane: Plane, 'train-front': TrainFront, car: Car, ship: Ship, bus: Bus, bike: Bike, footprints: Footprints, mountain: Mountain,
  'mountain-snow': MountainSnow, tent: Tent, 'tree-palm': TreePalm, trees: Trees, sun: Sun, sunset: Sunset, moon: Moon, 'cloud-sun': CloudSun,
  snowflake: Snowflake, umbrella: Umbrella, waves: Waves, camera: Camera, 'map-pin': MapPin, compass: Compass, globe: Globe, heart: Heart,
  star: Star, coffee: Coffee, utensils: Utensils, wine: Wine, 'ice-cream-cone': IceCreamCone, landmark: Landmark, castle: Castle, hotel: Hotel,
  anchor: Anchor, sailboat: Sailboat, luggage: Luggage, ticket: Ticket, music: Music, sparkles: Sparkles, flag: Flag, gift: Gift,
});

const UI = {
  photos: Images, text: Type, rect: Square, ellipse: Circle, line: Minus, grid: Grid2x2, route: Route, stats: ChartColumn, undo: Undo2,
  redo: Redo2, zoomIn: ZoomIn, zoomOut: ZoomOut, print: Printer, download: Download, upload: Upload, lock: Lock, unlock: LockOpen,
  front: BringToFront, back: SendToBack, up: ArrowUp, down: ArrowDown, layouts: LayoutTemplate, duplicate: Copy, importFile: FileUp,
  exportFile: FileDown, book: BookImage, elements: Shapes, auto: Wand2, map: Earth, fit: Maximize, rail: PanelLeft, props: SlidersHorizontal,
  addPhoto: ImagePlus, bold: Bold, italic: Italic, alignStart: AlignLeft, alignCenter: AlignCenter, alignEnd: AlignRight, delete: Trash2,
  add: Plus, settings: Settings, people: Users, flag: Flag, icon: Star,
};
// The rail and text alignment follow the inline direction.
const RTL = { rail: PanelRight, alignStart: AlignRight, alignEnd: AlignLeft };

export function icon(name, size = 18) {
  const node = (direction === 'rtl' && RTL[name]) || UI[name] || BOOK_ICONS[name];
  if (!node) return kitIcon(name, size);
  return createElement(node, { width: size, height: size, 'stroke-width': size <= 16 ? 2 : 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}

/** Prepends an editor icon to a kit button (the kit's own icon set is small). */
export function withIcon(node, name) {
  node.prepend(icon(name, 16));
  return node;
}

/** An icon element's SVG, sized by its box; stroke follows `color`. */
export function bookIcon(name, color) {
  const node = BOOK_ICONS[name];
  if (!node) return null;
  return createElement(node, { width: '100%', height: '100%', stroke: color, 'stroke-width': 1.6, 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid meet' });
}
