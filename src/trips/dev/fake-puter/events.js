import { jsonBytes, clone, error } from './shared.js';
import { isHandleId } from './shares.js';

const match = (pattern, value) => pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
export function createEvents(env, ctx) {
  if (!env.emitKv) {
    const deliver = (sub, event, allowed = () => true) => {
      const pending = Promise.resolve().then(() => {
        if (!env.subscriptions.has(sub.subId) || env.isOffline(sub.ctx.uid) || !allowed()) return;
        env.charge(sub.ctx, { events: 1 });
        return Promise.resolve(sub.handler({ event: clone(event) })).catch(cause => sub.options.onError?.(cause));
      });
      env.eventQueue.push(pending);
    };
    env.emitKv = (writer, scope, absolute, entry) => {
      if (entry.private) return;
      const matched = [];
      for (const sub of env.subscriptions.values()) {
        if (sub.kind !== 'kv' || sub.ctx.appUid !== scope.appUid) continue;
        const handle = env.handles.get(sub.anchorId);
        const allowed = () => handle ? Boolean(env.flags.shareHandles && env.liveHandle(handle.handle, sub.ctx.uid, sub.ctx.appUid)) : sub.ctx.uid === scope.uid && sub.anchorId === scope.appUid;
        if (!allowed() || (handle && (handle.uid !== scope.uid || !absolute.startsWith(handle.prefix)))) continue;
        const key = handle ? absolute.slice(handle.prefix.length) : absolute;
        if (match(sub.pattern, key)) matched.push({ sub, key, allowed });
      }
      const id = env.id('event');
      const counts = new Map();
      for (const { sub, key, allowed } of matched) {
        // Numbered per subscriber so deliveries reveal nothing about other users' subscriptions.
        const seq = counts.get(sub.ctx.uid) ?? 0; counts.set(sub.ctx.uid, seq + 1);
        const event = { id, subject: `kv:${sub.anchorId}:${key}`, key, op: entry.eventOp ?? (entry.deleted ? 'del' : 'set'), self: writer.uid === sub.ctx.uid, viaWorker: Boolean(writer.worker), ts: env.now(), seq };
        if (sub.options.includeValue && jsonBytes(entry.value) <= 16 * 1024 && matched.length <= 128 && event.op !== 'expire') event.value = entry.deleted ? null : clone(entry.value);
        deliver(sub, event, allowed);
      }
    };
    env.emitFs = (writer, node, op, from) => {
      const id = env.id('event');
      for (const sub of env.subscriptions.values()) {
        if (sub.kind !== 'fs' || (sub.op && sub.op !== op)) continue;
        const permitted = () => env.fsPermission(sub.ctx, node, 'list');
        const matches = path => sub.pattern.includes('*') ? match(sub.pattern.replace(/\*\*/g, '*'), path) : path === sub.pattern || path.startsWith(sub.pattern + '/');
        if (permitted() && (matches(node.path) || (from && matches(from)))) deliver(sub, { id, subject: `fs:${node.uid}:${op}`, uid: node.uid, path: node.path, op, self: sub.ctx.uid === writer.uid, viaWorker: Boolean(writer.worker), ts: env.now(), ...(from ? { from } : {}), seq: 0 }, permitted);
      }
    };
    env.notify = (uid, notification, appUid) => {
      const id = env.id('notification');
      for (const sub of env.subscriptions.values()) {
        if (sub.kind === 'notif' && sub.ctx.uid === uid && (!appUid || sub.ctx.appUid === appUid)) deliver(sub, { id, uid: id, op: 'post', subject: `notif:${sub.ctx.appUid}:app-user`, type: notification.type, audience: 'app-user', appUid: appUid ?? null, notification, self: true, ts: env.now(), seq: 0 });
      }
    };
    env.gap = uid => {
      for (const sub of env.subscriptions.values()) if (uid === '*' || sub.ctx.uid === uid) deliver(sub, { id: env.id('event'), subject: sub.subject, op: 'gap', reason: 'reconnect', ts: env.now() });
    };
  }
  return {
    async onLocal(subject, handler, options = {}) {
      return env.call(ctx, 'events.onLocal', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        if (typeof handler !== 'function' || typeof subject !== 'string' || !/^(kv|fs|notif):/.test(subject)) throw error('invalid_request');
        if ([...env.subscriptions.values()].filter(s => s.ctx === ctx).length >= 50) throw error('subscription_limit', 429);
        const subId = env.id('subscription');
        const sub = { subject, handler, options, subId, ctx };
        if (subject.startsWith('kv:')) {
          const [, anchorId, ...parts] = subject.split(':');
          sub.kind = 'kv'; sub.anchorId = anchorId; sub.pattern = parts.join(':');
          if (/[?]|\*(?!$)/.test(sub.pattern)) throw error('invalid_kv_pattern');
          if (isHandleId(anchorId)) {
            if (!env.flags.shareHandles) throw error('events_kv_handles_disabled', 403);
            if (!sub.pattern || sub.pattern.startsWith(':') || sub.pattern.split(':').includes('..')) throw error('invalid_kv_handle_key');
            // A handle that is unknown, stopped or someone else's reads like a subject that does not exist.
            if (!env.liveHandle(anchorId, ctx.uid, ctx.appUid)) throw error('subject_does_not_exist', 404);
          } else if (anchorId !== ctx.appUid) throw error('subject_does_not_exist', 404);
        } else if (subject.startsWith('fs:')) {
          sub.kind = 'fs';
          const operation = /:(add|write|move|remove|meta)$/.exec(subject);
          sub.op = operation?.[1];
          sub.pattern = env.fsPath(ctx, subject.slice(3, operation ? -operation[0].length : undefined));
          const base = sub.pattern.split('*')[0].replace(/\/$/, '');
          const node = env.fsNode(ctx, base);
          if (node && !env.fsPermission(ctx, node, 'list')) throw error('permission_denied', 403);
          if (!node && !base.startsWith(env.fsPath(ctx, '') + '/')) throw error('permission_denied', 403);
        } else sub.kind = 'notif';
        sub.off = async () => { env.subscriptions.delete(subId); };
        sub.unsubscribe = sub.off;
        sub.anchor = { uid: sub.anchorId ?? sub.pattern, path: '' };
        env.subscriptions.set(subId, sub);
        return { subject, subId, anchor: sub.anchor, includeValue: !!options.includeValue, off: sub.off, unsubscribe: sub.off };
      });
    },
    async unsubscribe(id) { return env.call(ctx, 'events.unsubscribe', () => { const key = typeof id === 'string' ? id : id.subId; const sub = env.subscriptions.get(key); if (sub && sub.ctx !== ctx) throw error('permission_denied', 403); env.subscriptions.delete(key); }); },
  };
}
