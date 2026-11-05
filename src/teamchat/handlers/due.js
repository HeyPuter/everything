/** Published as one self-contained function expression in the app's events worker. */
async function teamchatDue({ ctx, user }) {
  if (!ctx || typeof ctx.u !== 'string' || !ctx.u.startsWith('https://') || typeof ctx.w !== 'string') return;
  try {
    const res = await user.workers.exec(`${ctx.u}/api/ws/${encodeURIComponent(ctx.w)}/due`, { method: 'POST' });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`due ${res.status}`), { status: res.status });
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || err?.code);
    if (status === 429 || status >= 500 || err?.code === 'too_many_requests' || (!status && (!err?.code || /network|timeout|fetch/i.test(String(err.code))))) {
      throw Object.assign(new Error(err?.message || 'due request failed'), { retry: true });
    }
  }
}
