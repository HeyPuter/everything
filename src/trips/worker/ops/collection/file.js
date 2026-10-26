// Collection files may link only to saved places (their photos) and to meta (the cover).
import { checkFileLinks } from '../trip/file.js';

export const COLLECTION_LINK_TYPES = Object.freeze(['saved', 'meta']);

export default Object.freeze({
  check({ after }) { checkFileLinks(after, COLLECTION_LINK_TYPES); },
});
