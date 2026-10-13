/**
 * A script transport for tests: the joined source runs in a worker thread, inside a fresh vm context that stands in
 * for a browser worker's global (postMessage, message events, timers, and the network and storage objects a worker
 * would have, so the runtime's removal of them can be seen). Terminating the thread stops the script mid-loop, as
 * removing the sandbox frame does in the app.
 */
import { Worker } from 'node:worker_threads';

const SHIM = `
const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');
const listeners = { message: [], error: [], unhandledrejection: [] };
const dispatch = (type, event) => { for (const fn of listeners[type] || []) fn(event); };
const URL_NAME = 'blob:test/script';
const sandbox = {
  postMessage: (m) => parentPort.postMessage(m),
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: () => {},
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  location: { href: URL_NAME },
  // What a real worker global has and a script must not reach.
  fetch: () => 'fetched', XMLHttpRequest: function () {}, WebSocket: function () {}, importScripts: () => {},
  indexedDB: {}, caches: {}, navigator: { userAgent: 'test' }, BroadcastChannel: function () {}, Worker: function () {},
};
const context = vm.createContext(sandbox);
vm.runInContext('self = globalThis;', context);
process.on('unhandledRejection', (reason) => dispatch('unhandledrejection', { reason, preventDefault() {} }));
process.on('uncaughtException', (error) => dispatch('error', { error, message: String(error && error.message), preventDefault() {} }));
parentPort.on('message', (data) => dispatch('message', { data }));
let script;
try {
  script = new vm.Script(workerData.source, { filename: URL_NAME });
} catch (e) {
  const m = /:(\\d+)\\s*$/m.exec(String(e.stack).split('\\n')[0]);
  parentPort.postMessage({ type: 'load-error', message: e.name + ': ' + e.message, line: m ? Number(m[1]) : 0 });
}
if (script) script.runInContext(context);
`;

/** A transport factory for runScript; `made` collects the workers so a test can see them stopped. */
export function nodeTransport(made = []) {
  return (source, onMessage) => {
    const worker = new Worker(SHIM, { eval: true, workerData: { source } });
    made.push(worker);
    worker.on('message', onMessage);
    worker.on('error', (e) => onMessage({ type: 'load-error', message: e.message, line: 0 }));
    return {
      post: (m) => worker.postMessage(m),
      terminate: () => worker.terminate(),
    };
  };
}
