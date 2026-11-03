// Trip host worker entry. The runtime provides `router` at load and `me` from the first request on, so `me` is
// passed as a getter and never touched at the top level.
/* global router, me */
import { install } from './app.js';

install({ router, me: () => me });
