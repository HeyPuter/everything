import { workerURL } from "./protocol.js";
import { authorize, refuseCredential } from "./auth.js";

const workerKey = "whiteboard-collaboration-worker-v1";
const deploymentChecks = new WeakMap();
function checksFor(puter) {
  let entry = deploymentChecks.get(puter);
  if (!entry || entry.auth !== puter.authToken) {
    entry = { auth: puter.authToken, servers: new Map() };
    deploymentChecks.set(puter, entry);
  }
  return entry.servers;
}

export function refreshDeployment(puter, server) {
  server = workerURL(server);
  const checks = checksFor(puter);
  if (!checks.has(server)) {
    const pending = deploy(puter, () => {}, server);
    checks.set(server, pending);
    pending.catch(() => {
      if (checks.get(server) === pending) checks.delete(server);
    });
  }
  return checks.get(server);
}

// The slowest upload a request is given time for: a large batch of edits
// made offline still goes up over a congested venue connection.
const SLOW_UPLOAD = 50_000;
export async function call(puter, server, input) {
  const controller = new AbortController();
  const bodyText = JSON.stringify(input);
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(
      input.op?.startsWith("asset") ? 120000 : 30000,
      (bodyText.length / SLOW_UPLOAD) * 1000,
    ),
  );
  try {
    server = workerURL(server);
    let headers = await authorize(puter, server, bodyText);
    // Network failures and timeouts carry the browser's own wording, such
    // as "Failed to fetch"; people see a message they can act on instead.
    const unreachable = () =>
      Error(
        "Could not reach the shared board. Check your connection and try again.",
      );
    const send = async () => {
      try {
        controller.signal.throwIfAborted();
        return await puter.workers.exec(server + "/api", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: bodyText,
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw unreachable();
      }
    };
    let res = await send();
    // A credential that stopped working is replaced and the request sent
    // once more.
    if (res.status === 401 && refuseCredential(puter, headers)) {
      headers = await authorize(puter, server, bodyText);
      res = await send();
    }
    // A gateway error page is not JSON; its status still counts.
    const body = await res.json().catch(() => null);
    if (res.ok && !body) throw unreachable();
    if (!res.ok)
      throw Object.assign(
        Error(body?.message || "Could not synchronize this board."),
        {
          status: res.status,
          ...(typeof body?.detail === "string" ? { detail: body.detail } : {}),
        },
      );
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function deploy(puter, progress = () => {}, expectedServer) {
  const account = puter.authToken;
  const checkAccount = () => {
    if (puter.authToken !== account)
      throw Error("Your Puter account changed. Reopen the shared board.");
  };
  // A room URL alone never authorizes deployment. Only update an existing
  // worker that this account previously created and recorded in private KV.
  let config = await puter.kv.get(workerKey);
  checkAccount();
  if (
    expectedServer &&
    (!config || workerURL(config.server) !== expectedServer)
  )
    return;
  progress("Preparing collaboration…");
  const response = await fetch("/worker/whiteboard-worker.js", {
    cache: "no-cache",
  });
  if (!response.ok)
    throw Error("The collaboration server bundle could not load.");
  const source = await response.text();
  const build = /whiteboard-worker build=([a-f0-9]+)/.exec(source)?.[1];
  const builtAt = Number(/ at=(\d+)/.exec(source.slice(0, 150))?.[1]) || 0;
  if (!build) throw Error("Invalid collaboration server bundle.");
  checkAccount();
  if (!config) {
    const name =
      "whiteboard-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const file = await puter.fs.write(
      "whiteboard/whiteboard-worker.js",
      source,
      { overwrite: true, dedupeName: false, createMissingParents: true },
    );
    checkAccount();
    const deployed = await puter.workers.create(name, file.path);
    checkAccount();
    config = {
      name,
      server: workerURL(deployed.url || `https://${name}.puter.work`),
      path: file.path,
      build,
      builtAt,
    };
    await puter.kv.set(workerKey, config);
  } else if (config.build !== build && !(config.builtAt > builtAt)) {
    await puter.fs.write(config.path, source, {
      overwrite: true,
      dedupeName: false,
    });
    checkAccount();
    config.build = build;
    config.builtAt = builtAt;
    await puter.kv.set(workerKey, config);
  }
  checkAccount();
  progress("Starting collaboration…");
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await puter.workers.exec(
        workerURL(config.server) + "/health",
        { headers: { "x-puter-no-auth": "1" }, redirect: "error" },
      );
      if (res.ok && (await res.json()).build === config.build) {
        checkAccount();
        checksFor(puter).set(config.server, Promise.resolve(config.server));
        return config.server;
      }
    } catch {
      /* Deployment may still be starting. */
    }
    checkAccount();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(
    "The collaboration server is still starting. Try Share again shortly.",
  );
}
