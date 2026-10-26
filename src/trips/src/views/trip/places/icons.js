import {
  createElement, Star, Tag, ListFilter, SquareCheckBig, LocateFixed, ExternalLink, CalendarPlus, Globe, Phone, Banknote,
  Route, CircleCheckBig, ArrowUpDown, ClipboardPaste, Paperclip, Receipt, Palette, Bus, Utensils, Coffee, Wine, BedDouble,
  Landmark, Mountain, Trees, Waves, Camera, Ticket, ShoppingBag, Music, Baby, Dumbbell, Church, MapPin, TrainFront,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry. Category icons keep their stored kebab-case names.
const extra = {
  star: Star, tag: Tag, filter: ListFilter, select: SquareCheckBig, locate: LocateFixed, external: ExternalLink,
  addDay: CalendarPlus, web: Globe, phone: Phone, price: Banknote, track: Route, visited: CircleCheckBig, sort: ArrowUpDown,
  paste: ClipboardPaste, attach: Paperclip, receipt: Receipt, palette: Palette,
  'map-pin': MapPin, utensils: Utensils, coffee: Coffee, wine: Wine, 'bed-double': BedDouble, landmark: Landmark,
  mountain: Mountain, trees: Trees, waves: Waves, camera: Camera, ticket: Ticket, 'shopping-bag': ShoppingBag,
  music: Music, baby: Baby, dumbbell: Dumbbell, church: Church, bus: Bus, 'train-front': TrainFront,
};

export function icon(name, size = 18, { fill = false } = {}) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], {
    width: size, height: size, 'stroke-width': size <= 16 ? 2 : 1.8, 'aria-hidden': 'true', focusable: 'false',
    class: 'icon', ...(fill ? { fill: 'currentColor' } : {}),
  });
}
