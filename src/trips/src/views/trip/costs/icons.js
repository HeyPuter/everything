import {
  createElement, BedDouble, Utensils, ShoppingBasket, Bus, Plane, Ticket, Landmark, ShoppingBag, Receipt, HeartPulse, HandCoins,
  Fuel, SquareParking, CircleEllipsis, Download, Lock, RefreshCw, ArrowRight, Link, Paperclip, ListOrdered, Calculator, Coins,
} from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry: category icons by their kebab-case names, plus a few actions.
const extra = {
  'bed-double': BedDouble, utensils: Utensils, 'shopping-basket': ShoppingBasket, bus: Bus, plane: Plane, ticket: Ticket,
  landmark: Landmark, 'shopping-bag': ShoppingBag, receipt: Receipt, 'heart-pulse': HeartPulse, 'hand-coins': HandCoins,
  fuel: Fuel, 'square-parking': SquareParking, 'circle-ellipsis': CircleEllipsis,
  download: Download, lock: Lock, refresh: RefreshCw, to: ArrowRight, link: Link, paperclip: Paperclip, order: ListOrdered,
  math: Calculator, coins: Coins,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
