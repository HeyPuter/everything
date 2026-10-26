// Collections module: `#/collections` (the list) and `#/c/<worker>/<space>/<tab>` (one collection).
import '../trip/places/places.css';
import '../trip/members/members.css';
import './collections.css';
import { mountCollections } from './list.js';
import { mountCollection } from './detail.js';

export { mountCollectionsWidget } from './widget.js';

export async function mount(container, context) {
  const route = context.route ?? {};
  if (route.name === 'space' && route.ref?.k === 'collection') return mountCollection(container, context);
  return mountCollections(container, context);
}
