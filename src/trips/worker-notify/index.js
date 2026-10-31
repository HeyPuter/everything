// Events-worker handler `tripsNotify` (data-model §4, architecture §7). The build wraps this bundle in the
// closure-free function `async ({event, ctx, user, fetch}) => …` that `puter.events.handlers.publish` takes.
import { runHandler } from '../src/lib/notify-out/handler.js';

export function handle({ event, ctx, user, fetch }) {
  return runHandler({ event, ctx, user, fetch });
}
