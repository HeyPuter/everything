/**
 * Running a script: its code joined to the runtime (script-runtime.src.js) is handed to a transport, an isolated
 * place to run it (lib/script-sandbox.js in the app: a worker inside a sandboxed frame; a worker thread in tests),
 * and the messages it sends back are answered by a ScriptHost over the workbook. The run ends when main() returns
 * or throws, when it is stopped, or when it runs past its time; the transport is then torn down, which stops the
 * script wherever it was, and everything it changed is folded into one undo step.
 *
 * A transport is { post(message), terminate() } made by `transport(source, onMessage)`; it calls onMessage with
 * each message the script sends, and with { type: 'load-error', message, line } when the code cannot even start.
 */
import RUNTIME from './script-runtime.src.js?raw';
import { ScriptHost } from './script-host.js';

export const DEFAULT_SCRIPT_TIMEOUT = 120_000;

/** The runtime followed by the script: `firstLine` is the line its code starts on, for error positions. */
export function scriptSource(code) {
  const head = `${RUNTIME}\n`;
  const firstLine = head.split('\n').length;
  const text = String(code ?? '');
  return {
    source: `${head}${text}\n;__beginScript(typeof main === 'function' ? main : null);\n`,
    firstLine,
    lineCount: text.split('\n').length,
  };
}

/**
 * Run `code` against `wb`. Resolves with { ok, error: { message, line } | null, stopped, timedOut, changed }.
 * onLog({ level, text, line }) receives console output as it comes ({ clear: true } for console.clear()).
 * `signal` (an AbortSignal) stops the run. `env` goes to the ScriptHost (selection, select, autofit, distrust, name).
 */
export function runScript({ wb, code, transport, env = {}, timeout = DEFAULT_SCRIPT_TIMEOUT, label = 'Run script', onLog = null, signal = null }) {
  const { source, firstLine, lineCount } = scriptSource(code);
  const host = new ScriptHost(wb, env);
  const mark = wb.historyTop;
  const version = wb.version;
  let port = null;
  let done = false;
  let timer = null;
  let resolveRun;
  const result = new Promise((resolve) => { resolveRun = resolve; });
  // A line in the joined source, as a line of the script (0 when it is in the runtime).
  const scriptLine = (line) => (Number.isInteger(line) && line >= firstLine && line < firstLine + lineCount ? line - firstLine + 1 : 0);

  function finish(error, extra = {}) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    try { port?.terminate(); } catch { /* already gone */ }
    // Everything the script changed is one step, however many it took.
    wb.squashHistory(mark, label);
    resolveRun({ ok: !error, error: error || null, stopped: !!extra.stopped, timedOut: !!extra.timedOut, changed: wb.version !== version });
  }
  function onAbort() { finish({ message: 'The script was stopped.', line: 0 }, { stopped: true }); }

  function onMessage(m) {
    if (done || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        port.post({ type: 'start', context: host.context(), firstLine, lineCount });
        return;
      case 'ops':
        try { host.apply(m.ops); } catch (e) { finish({ message: e?.message || String(e), line: e?.line || 0 }); }
        return;
      case 'read': {
        let reply;
        try { reply = { type: 'result', id: m.id, value: host.read(m.op) }; } catch (e) { reply = { type: 'result', id: m.id, error: e?.message || String(e) }; }
        reply.sheets = host.sheetList();
        port.post(reply);
        return;
      }
      case 'log': onLog?.({ level: ['info', 'warn', 'error'].includes(m.level) ? m.level : 'log', text: String(m.text ?? ''), line: Number(m.line) || 0 }); return;
      case 'clear': onLog?.({ clear: true }); return;
      case 'done': finish(null); return;
      case 'error': finish({ message: `${m.name && m.name !== 'Error' && m.name !== 'ScriptError' ? `${m.name}: ` : ''}${String(m.message ?? 'The script failed')}`, line: Number(m.line) || 0 }); return;
      case 'load-error': finish({ message: String(m.message || 'The script could not be read').replace(/^Uncaught /, ''), line: scriptLine(Number(m.line)) }); return;
      default:
    }
  }

  if (signal?.aborted) { onAbort(); return result; }
  signal?.addEventListener?.('abort', onAbort);
  try {
    port = transport(source, onMessage);
  } catch (e) {
    finish({ message: e?.message || 'Scripts cannot run here', line: 0 });
    return result;
  }
  if (timeout > 0) timer = setTimeout(() => finish({ message: `The script ran for more than ${Math.round(timeout / 1000)} seconds and was stopped.`, line: 0 }, { timedOut: true }), timeout);
  return result;
}
