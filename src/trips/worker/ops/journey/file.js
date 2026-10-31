// Journey files may link only to entries (media) and to meta (the cover).
import { checkFileLinks } from '../trip/file.js';

export const JOURNEY_LINK_TYPES = Object.freeze(['entry', 'meta']);

export default Object.freeze({
  check({ after }) { checkFileLinks(after, JOURNEY_LINK_TYPES); },
});
