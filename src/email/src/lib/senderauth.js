/**
 * The sender check Puter records on mail that names one of Puter's own domains
 * in its From header: was it really signed by that domain. Puter writes the
 * result as the first `X-Puter-Sender-Auth` header when it files a message and
 * removes any copy the sender supplied, so the first one is Puter's.
 *
 *   <result>; from=<domains>; signed-by=<domains|none>[; via=local]
 */

const HEADER = 'x-puter-sender-auth';
const RESULTS = new Set(['pass', 'fail', 'temperror']);

const domains = (list) =>
  (!list || list === 'none' ? [] : list.split(',').map((name) => name.trim()).filter(Boolean));

/**
 * @param {Map<string, string>} headers From `parseHeaders`, which keeps the
 *   first of a repeated header.
 * @returns {{ result: 'pass'|'fail'|'temperror', from: string[], signedBy: string[], local: boolean } | null}
 */
export const parseSenderAuth = (headers) => {
  const value = headers?.get(HEADER);
  if (!value) return null;
  const [result, ...params] = value.split(';').map((part) => part.trim());
  if (!RESULTS.has(result)) return null;
  const named = {};
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq <= 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (!(key in named)) named[key] = param.slice(eq + 1).trim();
  }
  const from = domains(named.from);
  // Puter always names the domains it checked; without them it isn't its stamp.
  if (from.length === 0) return null;
  return {
    result,
    from,
    signedBy: domains(named['signed-by']),
    local: named.via === 'local',
  };
};

/**
 * What to tell the reader about a message's sender, or null when there is
 * nothing to say: the check passed, or the message was never checked. Anything
 * short of a pass is an unverified sender; a failure is said louder. A failed
 * check means the domain's signature is missing or broken, which a forwarder
 * can also cause, so the text stops short of calling it a forgery.
 *
 * @returns {{ level: 'fail' | 'unverified', text: string } | null}
 */
export const senderNotice = (auth) => {
  if (!auth || auth.result === 'pass') return null;
  const claimed = auth.from.join(', ');
  if (auth.result === 'fail') {
    return {
      level: 'fail',
      text: `This message says it is from ${claimed}, but it isn't signed by ${claimed} and may be forged. `
        + 'Don\'t open its links or attachments, and don\'t reply with passwords or codes.',
    };
  }
  return {
    level: 'unverified',
    text: `We couldn't confirm that this message came from ${claimed}. `
      + 'Be careful with its links and attachments.',
  };
};
