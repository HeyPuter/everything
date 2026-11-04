/**
 * The shared email worker (worker/email.js): the real route code against the
 * in-memory runtime, with `me.puter.email.sendTransactional` replaced by a recorder. What
 * matters here is what an app-owned relay must never do — send for nobody,
 * send anywhere but the app, relay caller markup, or outrun its caps.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
  createMemoryKv,
  createMemoryFs,
  createWorkerRuntime,
} from "../dev/worker-runtime.js";

const BASE = "https://teamchat-email.test";
const alice = { uuid: "u-alice-0000", username: "alice" };
const bob = { uuid: "u-bob-0000", username: "bob" };

let runtime;
let sends;
let sendImpl;

beforeAll(async () => {
  runtime = await createWorkerRuntime({
    kv: createMemoryKv(),
    fs: createMemoryFs(),
    owner: { uuid: "u-dev-0000", username: "dev" },
    loadWorker: () => import("../worker/email.js"),
  });
});

beforeEach(() => {
  sends = [];
  sendImpl = null;
  runtime.setStores({ kv: createMemoryKv() });
  globalThis.me.puter.email = {
    sendTransactional: async (message) => {
      sends.push(message);
      return sendImpl ? sendImpl(message) : {};
    },
  };
});

const invite = (over = {}) => ({
  kind: "workspace",
  server: "alice.puter.work",
  code: "ABCD-EFGH-JKLM",
  workspace: "Acme",
  inviter: "Alice A.",
  emails: ["pat@example.com"],
  ...over,
});

async function post(body, caller = alice) {
  const res = await runtime.dispatch(
    `${BASE}/invites`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    caller,
  );
  return { status: res.status, data: await res.json() };
}

describe("the shared email worker", () => {
  it("prefers sendTransactional when the runtime also exposes send", async () => {
    let legacyCalls = 0;
    globalThis.me.puter.email.send = async () => { legacyCalls++; };
    expect((await post(invite())).data).toMatchObject({ sent: 1, failed: 0 });
    expect(sends).toHaveLength(1);
    expect(legacyCalls).toBe(0);
  });

  it("sends with an older runtime exposing only send", async () => {
    const email = globalThis.me.puter.email;
    email.send = email.sendTransactional;
    delete email.sendTransactional;
    expect((await post(invite())).data).toMatchObject({ sent: 1, failed: 0 });
    expect(sends).toHaveLength(1);
  });

  it("does not retry a rejected delivery through the legacy alias", async () => {
    let legacyCalls = 0;
    globalThis.me.puter.email.send = async () => { legacyCalls++; };
    sendImpl = () => { throw new Error("mailbox unavailable"); };
    expect((await post(invite())).data).toMatchObject({ sent: 0, failed: 1 });
    expect(sends).toHaveLength(1);
    expect(legacyCalls).toBe(0);
  });

  it("answers /health without auth", async () => {
    const res = await runtime.dispatch(`${BASE}/health`, {}, null);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("reports the baked-in runtime, null under the harness", async () => {
    const res = await runtime.dispatch(`${BASE}/health`, {}, null);
    expect((await res.json()).runtime).toBeNull();

    // The module is imported once (beforeAll), so set the global before this
    // dispatch, not before the import.
    globalThis.__PUTER_PREAMBLE_VERSION__ = "2.6.2+63f857ce3";
    try {
      const res2 = await runtime.dispatch(`${BASE}/health`, {}, null);
      expect((await res2.json()).runtime).toBe("2.6.2+63f857ce3");
    } finally {
      delete globalThis.__PUTER_PREAMBLE_VERSION__;
    }
  });

  it("refuses a caller with no session: an open relay for nobody", async () => {
    const { status, data } = await post(invite(), null);
    expect(status).toBe(401);
    expect(data.error).toBe("sign_in_required");
    expect(sends).toHaveLength(0);
  });

  it("sends a workspace invitation: subject, both bodies, the join link", async () => {
    const { status, data } = await post(
      invite({
        emails: ["pat@example.com", "sam@example.com"],
        note: "See you inside!",
      }),
    );
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(data.results.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(sends).toHaveLength(2);
    const mail = sends[0];
    expect(mail.to).toBe("pat@example.com");
    expect(mail.subject).toBe("Alice A. invited you to Acme on Teamchat");
    const link =
      "https://teamchat.puter.com#/join/alice.puter.work/ABCD-EFGH-JKLM";
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(link);
    expect(mail.html).toContain("See you inside!");
    expect(mail.text).toContain("See you inside!");
    // The plain-text body keeps its paragraph breaks: heading, lead, the
    // link line, and the closing are separated, not run together.
    expect(mail.text).toMatch(/invited you to join Acme\n\nTeamchat is where/);
    expect(mail.text).toMatch(/\n\nJoin the workspace: /);
    expect(mail.text).toMatch(/\n\nIf you were not expecting this/);
  });

  it("composes the guest and connect flavors around their own links", async () => {
    await post(invite({ kind: "guest", channel: "design" }));
    expect(sends[0].subject).toBe("Alice A. invited you to #design in Acme");
    expect(sends[0].text).toContain("#/join/alice.puter.work/ABCD-EFGH-JKLM");

    await post(invite({ kind: "connect", channel: "design" }));
    expect(sends[1].subject).toContain("share the #design channel");
    expect(sends[1].text).toContain(
      "#/connect/alice.puter.work/ABCD-EFGH-JKLM",
    );

    // Both flavors need the channel's name.
    expect((await post(invite({ kind: "guest" }))).status).toBe(400);
    expect((await post(invite({ kind: "connect" }))).status).toBe(400);
  });

  it("refuses what it cannot vouch for: kind, server, code, addresses", async () => {
    expect((await post(invite({ kind: "newsletter" }))).data).toMatchObject({
      error: "invalid",
      reason: "kind",
    });
    expect((await post(invite({ server: "evil host!" }))).data).toMatchObject({
      error: "invalid",
      reason: "server",
    });
    expect((await post(invite({ code: "no codes here" }))).data).toMatchObject({
      error: "invalid",
      reason: "code",
    });
    expect(
      (await post(invite({ emails: ["not-an-email"] }))).data,
    ).toMatchObject({ error: "invalid", reason: "emails" });
    expect((await post(invite({ workspace: "" }))).data).toMatchObject({
      error: "invalid",
      reason: "names",
    });
    expect(
      (
        await post(
          invite({
            emails: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`),
          }),
        )
      ).data.error,
    ).toBe("too_many_recipients");
    expect(sends).toHaveLength(0);
  });

  it("does not take an inherited property name as a kind", async () => {
    // KINDS['constructor'] and friends are truthy but not invitations; each
    // must be refused cleanly (not a 500 from KINDS[kind].subject), and none
    // may spend the caller's daily budget.
    for (const kind of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const res = await post(invite({ kind }));
      expect(res.status, kind).toBe(400);
      expect(res.data, kind).toMatchObject({
        error: "invalid",
        reason: "kind",
      });
    }
    expect(sends).toHaveLength(0);
    // A real send still lands afterward: the budget was never touched.
    expect((await post(invite())).data.sent).toBe(1);
  });

  it("links only to places the app lives; anywhere else falls back to the canonical URL", async () => {
    await post(invite({ app: "https://teamchat.puter.site/" }));
    expect(sends[0].text).toContain("https://teamchat.puter.site#/join/");
    await post(invite({ app: "https://teamchat-look-alike.example.com" }));
    expect(sends[1].text).toContain("https://teamchat.puter.com#/join/");
    await post(invite({ app: "http://localhost:5273/mock.html" }));
    expect(sends[2].text).toContain("http://localhost:5273/mock.html#/join/");
  });

  it("escapes caller text in the html body and strips newlines from the subject", async () => {
    await post(
      invite({
        workspace: "Acme <img src=x onerror=alert(1)>",
        inviter: "Alice\r\nBcc: everyone@example.com",
        note: "<script>alert(1)</script>",
      }),
    );
    const mail = sends[0];
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain("Alice Bcc: everyone@example.com");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    // A C1 control character (U+0085 NEL) is a line break to some parsers and
    // JS's \s misses it, so it must not survive into the subject either.
    const c1 = new RegExp(
      `[${String.fromCharCode(0x80)}-${String.fromCharCode(0x9f)}]`,
    );
    await post(invite({ inviter: `Ana${String.fromCharCode(0x85)}Boss` }));
    expect(sends[1].subject).not.toMatch(c1);
    expect(sends[1].subject).toContain("Ana Boss");
    // An address carrying a control character is not a deliverable recipient.
    const bad = await post(
      invite({ emails: [`pat${String.fromCharCode(0)}@example.com`] }),
    );
    expect(bad.data).toMatchObject({ error: "invalid", reason: "emails" });
  });

  it("reports a failed or suppressed recipient without failing the batch", async () => {
    sendImpl = (message) =>
      message.to === "gone@example.com"
        ? { suppressed: ["gone@example.com"] }
        : {};
    const { data } = await post(
      invite({ emails: ["gone@example.com", "pat@example.com"] }),
    );
    expect(data.sent).toBe(1);
    expect(data.suppressed).toBe(1);
    expect(data.results).toContainEqual({
      email: "gone@example.com",
      status: "suppressed",
    });

    sendImpl = () => {
      throw new Error("mailbox unavailable");
    };
    const second = await post(invite());
    expect(second.data.sent).toBe(0);
    expect(second.data.failed).toBe(1);
    expect(second.data.results[0].reason).toContain("mailbox unavailable");
  });

  it("caps a caller at 100 sends per day, per caller", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `p${i}@example.com`);
    for (let i = 0; i < 10; i++) {
      expect(
        (await post(invite({ emails: many.map((e) => `${i}.${e}`) }))).data
          .sent,
      ).toBe(10);
    }
    const over = await post(invite({ emails: ["extra@example.com"] }));
    expect(over.status).toBe(429);
    expect(over.data.error).toBe("daily_limit");
    expect(sends).toHaveLength(100);
    // Somebody else still has their own budget.
    expect((await post(invite(), bob)).data.sent).toBe(1);
  });

  it("holds the daily cap under concurrent requests", async () => {
    // A network KV answers with latency; twenty 10-recipient requests fire at
    // once against a 100/day cap. The reserve increments atomically, so
    // exactly 100 send however they interleave. A read-then-write reserve
    // would let every request read the same low count over that latency and
    // send its whole batch — the real overrun this guards against.
    const base = createMemoryKv();
    const lag = () => new Promise((r) => setTimeout(r, 2));
    const origGet = base.get.bind(base);
    const origIncr = base.incr.bind(base);
    base.get = async (...a) => {
      await lag();
      return origGet(...a);
    };
    base.incr = async (...a) => {
      await lag();
      return origIncr(...a);
    };
    runtime.setStores({ kv: base });
    const batches = Array.from({ length: 20 }, (_, i) =>
      post(
        invite({
          emails: Array.from(
            { length: 10 },
            (_, j) => `c${i}.${j}@example.com`,
          ),
        }),
      ),
    );
    const results = await Promise.all(batches);
    const total = results.reduce((n, r) => n + (r.data.sent || 0), 0);
    expect(total).toBe(100);
    expect(sends).toHaveLength(100);
  });

  it("deduplicates and lowercases addresses before sending", async () => {
    const { data } = await post(
      invite({ emails: ["Pat@Example.com", "pat@example.com"] }),
    );
    expect(data.sent).toBe(1);
    expect(sends[0].to).toBe("pat@example.com");
  });
});
