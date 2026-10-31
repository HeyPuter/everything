import {
  createElement, Upload, Download, Lock, LockOpen, Eye, EyeOff, Copy, ListChecks, Backpack, IdCard, BookUser, Car, Stamp,
  Award, ShieldCheck, FileText, MapPin, Utensils, Coffee, Wine, BedDouble, Landmark, Mountain, Trees, Waves, Camera, Ticket,
  ShoppingBag, Music, Baby, Dumbbell, Church, Tag, Smartphone, Monitor,
} from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';

// Icons the kit does not carry; category icons use their stored kebab-case names.
const extra = {
  upload: Upload, download: Download, lock: Lock, unlock: LockOpen, eye: Eye, eyeOff: EyeOff, copy: Copy, list: ListChecks,
  backpack: Backpack, tag: Tag, phone: Smartphone, desktop: Monitor,
  passport: BookUser, id: IdCard, license: Car, visa: Stamp, loyalty: Award, insurance: ShieldCheck, other: FileText,
  'map-pin': MapPin, utensils: Utensils, coffee: Coffee, wine: Wine, 'bed-double': BedDouble, landmark: Landmark, mountain: Mountain,
  trees: Trees, waves: Waves, camera: Camera, ticket: Ticket, 'shopping-bag': ShoppingBag, music: Music, baby: Baby, dumbbell: Dumbbell, church: Church,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
