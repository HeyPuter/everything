import {
  createElement, Heart, Star, Bookmark, BookmarkPlus, MapPin, Utensils, Coffee, Wine, Landmark, Mountain, Trees, Waves, Camera,
  ShoppingBag, Music, Ticket, BedDouble, Plane, Flag, Gem, Sparkles, Tag, ListFilter, SquareCheckBig, Download, Upload, Share2,
  Globe, Link, Library, Eye, FolderInput, CopyPlus, CircleCheckBig, Lightbulb, RotateCcw, Palette, LogOut, Settings, LocateFixed,
  CalendarPlus, ExternalLink, Layers, List, UserPlus,
} from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';

/** Icons a collection may use; the worker checks the same list (worker/ops/collection/meta.js). */
export const COLLECTION_ICONS = Object.freeze([
  'heart', 'star', 'bookmark', 'map-pin', 'utensils', 'coffee', 'wine', 'landmark', 'mountain', 'trees',
  'waves', 'camera', 'shopping-bag', 'music', 'ticket', 'bed-double', 'plane', 'flag', 'gem', 'sparkles',
]);

const extra = {
  heart: Heart, star: Star, bookmark: Bookmark, save: BookmarkPlus, 'map-pin': MapPin, utensils: Utensils, coffee: Coffee, wine: Wine,
  landmark: Landmark, mountain: Mountain, trees: Trees, waves: Waves, camera: Camera, 'shopping-bag': ShoppingBag, music: Music,
  ticket: Ticket, 'bed-double': BedDouble, plane: Plane, flag: Flag, gem: Gem, sparkles: Sparkles,
  tag: Tag, filter: ListFilter, select: SquareCheckBig, download: Download, upload: Upload, share: Share2, web: Globe, link: Link,
  all: Library, eye: Eye, move: FolderInput, duplicate: CopyPlus, visited: CircleCheckBig, idea: Lightbulb, revisit: RotateCcw,
  palette: Palette, leave: LogOut, settings: Settings, locate: LocateFixed, addTrip: CalendarPlus, external: ExternalLink,
  layers: Layers, list: List, invite: UserPlus,
};

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': size <= 16 ? 2 : 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
