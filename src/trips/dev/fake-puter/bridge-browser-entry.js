import { createRemoteFakePuter } from './bridge-client.js';
if (globalThis.top === globalThis) {
const options = globalThis.__tripsFakeBridgeOptions;
delete globalThis.__tripsFakeBridgeOptions;
const remote = createRemoteFakePuter({ request: envelope => globalThis[options.binding](envelope), maxBytes: options.maxBytes });
Object.defineProperty(globalThis, options.delivery, { value: remote.receive, configurable: true });
globalThis.puter = remote.client;
globalThis.__fakePuterBridgeReady = remote.client.ready;
addEventListener('offline', () => { remote.connection(false).catch(() => {}); });
addEventListener('online', () => { remote.connection(true).catch(() => {}); });

}
