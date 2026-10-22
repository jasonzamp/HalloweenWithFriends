const { app } = require("@azure/functions");
const { makeStore } = require("../lib/store");
const { makeHandlers } = require("../lib/handlers");

// The test copy keeps its own activities and votes, so trying things out never touches the live page.
// It's chosen by DATA_PREFIX on the server, or by the test site sending "x-data-env: test".
const sets = {};
function h(req) {
  const fixed = (process.env.DATA_PREFIX || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const prefix = fixed || (req?.headers?.get("x-data-env") === "test" ? "test" : "");
  return (sets[prefix] ||= makeHandlers(makeStore(process.env.STORAGE_CONNECTION_STRING, { prefix }), { adminCode: process.env.ADMIN_CODE || "" }));
}

const headersOf = req => Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
async function jsonBody(req) { try { return await req.json(); } catch { return {}; } }

function wrap(fn) {
  return async (req, ctx) => {
    try {
      const r = await fn(req, ctx);
      if (r.raw) return { status: r.status, body: r.raw, headers: r.headers };
      if (r.status === 204 || r.status === 404 && r.body === undefined) return { status: r.status };
      return { status: r.status, jsonBody: r.body, headers: { "cache-control": "no-store" } };
    } catch (e) {
      if (e.status) return { status: e.status, jsonBody: { error: e.message } };
      ctx.error(e);
      return { status: 500, jsonBody: { error: "Something went wrong on the server. Try again in a moment." } };
    }
  };
}

// One-off: owner-requested date fix on the real page. Protected by a token only the deployer holds; removed after use.
const FIX_HASH = "71cc79760f496f6da3b3eb7dd4d586795c5d1699a60df0d4c822a0b0345547b9";
app.http("fixWhen", { methods: ["POST"], route: "fix-when", authLevel: "anonymous",
  handler: wrap(async req => {
    const tok = req.headers.get("x-fix-token") || "";
    if (require("crypto").createHash("sha256").update(tok).digest("hex") !== FIX_HASH) return { status: 404, body: { error: "Not found" } };
    const b = await jsonBody(req);
    const store = makeStore(process.env.STORAGE_CONNECTION_STRING);
    const act = await store.getActivity(String(b.id || ""));
    if (!act || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(b.when || "")) return { status: 400, body: { error: "bad request" } };
    act.when = b.when; await store.replaceActivity(act, act.etag);
    return { status: 200, body: { title: act.title, when: act.when } };
  }) });

app.http("state", { methods: ["GET"], route: "state", authLevel: "anonymous", handler: wrap(req => h(req).state()) });

app.http("createActivity", { methods: ["POST"], route: "activities", authLevel: "anonymous",
  handler: wrap(async req => h(req).createActivity(headersOf(req), await jsonBody(req))) });

app.http("addOption", { methods: ["POST"], route: "activities/{id}/options", authLevel: "anonymous",
  handler: wrap(async req => h(req).addOption(headersOf(req), req.params.id, await jsonBody(req))) });

app.http("setOptionImage", { methods: ["PUT"], route: "activities/{id}/options/{oid}/image", authLevel: "anonymous",
  handler: wrap(async req => h(req).setOptionImage(headersOf(req), req.params.id, req.params.oid, await jsonBody(req))) });

app.http("setActivityImage", { methods: ["PUT"], route: "activities/{id}/image", authLevel: "anonymous",
  handler: wrap(async req => h(req).setActivityImage(headersOf(req), req.params.id, await jsonBody(req))) });

app.http("setWhen", { methods: ["PUT"], route: "activities/{id}/when", authLevel: "anonymous",
  handler: wrap(async req => h(req).setWhen(headersOf(req), req.params.id, await jsonBody(req))) });

app.http("deleteOption", { methods: ["DELETE"], route: "activities/{id}/options/{oid}", authLevel: "anonymous",
  handler: wrap(async req => h(req).deleteOption(headersOf(req), req.params.id, req.params.oid)) });

app.http("deleteActivity", { methods: ["DELETE"], route: "activities/{id}", authLevel: "anonymous",
  handler: wrap(async req => h(req).deleteActivity(headersOf(req), req.params.id)) });

app.http("vote", { methods: ["PUT"], route: "vote", authLevel: "anonymous",
  handler: wrap(async req => h(req).vote(headersOf(req), await jsonBody(req))) });

app.http("uploadImage", { methods: ["POST"], route: "images", authLevel: "anonymous",
  handler: wrap(async req => h(req).uploadImage(headersOf(req), Buffer.from(await req.arrayBuffer()), req.headers.get("content-type"))) });

app.http("preview", { methods: ["POST"], route: "preview", authLevel: "anonymous",
  handler: wrap(async req => h(req).preview(headersOf(req), await jsonBody(req))) });

app.http("getImage", { methods: ["GET"], route: "images/{id}", authLevel: "anonymous",
  handler: wrap(async req => h(req).getImage(req.params.id)) });
