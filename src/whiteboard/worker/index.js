import { BoardService } from "./service.js";
import { OrgService } from "./org.js";
import { organizationRequest } from "./admin.js";
import { authenticate } from "./auth.js";
import { restRequest } from "./api.js";

// Operations that act on the organization rather than one board.
const ORG_OPS =
  /^(org\.|email\.|notifications\.|prefs\.|library\.|spaces\.|teams\.|apikeys\.|webhooks\.|migration\.|feedback\.)/;
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function readBody(request, limit = 17_000_000) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(Error("Request too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(body);
}

router.get("/health", () =>
  Response.json({
    ok: true,
    protocol: 1,
    build: __WORKER_BUILD__,
    builtAt: __WORKER_BUILT_AT__,
    features: ["organization", "scim", "rest", "audit", "siem"],
  }),
);
router.post("/api", async ({ request, user }) => {
  try {
    if (!user?.puter)
      return new Response(
        JSON.stringify({ message: "Sign in with Puter to continue." }),
        { status: 401 },
      );
    const text = await readBody(request);
    if (text === null)
      return Response.json(
        { message: "A JSON request body is required." },
        { status: 400 },
      );
    const input = JSON.parse(text);
    const identity = await authenticate(request, user.puter, input);
    const org = new OrgService(me.puter, { request });
    const boards = new BoardService(me.puter, { org, request });
    if (typeof input?.op === "string" && ORG_OPS.test(input.op))
      return Response.json(
        await organizationRequest(org, boards, identity, input),
      );
    return Response.json(await boards.call(identity, input));
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof SyntaxError
            ? "Invalid JSON request."
            : error.status
              ? error.message
              : "The board could not synchronize. Please retry.",
        // Another service's reason for refusing, such as Jira's, apart from
        // the message so the message can still be translated.
        ...(error.status && typeof error.detail === "string"
          ? { detail: error.detail }
          : {}),
      },
      { status: error.status || (error instanceof SyntaxError ? 400 : 500) },
    );
  }
});
// Documented REST and SCIM 2.0 endpoints, authenticated with API keys that
// organization administrators create. They never accept Puter sessions.
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
  for (const path of ["/v1/*path", "/scim/v2/*path", "/scim/v2"])
    router.custom(method, path, async ({ request, params }) => {
      try {
        const text = ["GET", "DELETE"].includes(method)
          ? null
          : await readBody(request, 2_000_000);
        const body = text ? JSON.parse(text) : null;
        const org = new OrgService(me.puter, { request });
        const boards = new BoardService(me.puter, { org, request });
        return await restRequest(
          org,
          boards,
          request,
          method,
          params.path || "",
          body,
        );
      } catch (error) {
        const scim = new URL(request.url).pathname.startsWith("/scim/");
        const status = error instanceof SyntaxError ? 400 : error.status || 500;
        const message =
          error instanceof SyntaxError
            ? "Invalid JSON request."
            : error.status
              ? error.message
              : "The request could not be completed.";
        return scim
          ? json(
              {
                schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
                status: String(status),
                ...(error instanceof SyntaxError
                  ? { scimType: "invalidSyntax" }
                  : error.scimType
                    ? { scimType: error.scimType }
                    : {}),
                detail: message,
              },
              status,
              { "Content-Type": "application/scim+json" },
            )
          : json({ error: message }, status);
      }
    });
