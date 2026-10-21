const { app } = require("@azure/functions");
const { makeStore } = require("../lib/store");
const { makeHandlers } = require("../lib/handlers");

let handlers = null;
const h = () => (handlers ||= makeHandlers(makeStore(process.env.STORAGE_CONNECTION_STRING), { adminCode: process.env.ADMIN_CODE || "" }));

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

app.http("state", { methods: ["GET"], route: "state", authLevel: "anonymous", handler: wrap(() => h().state()) });

app.http("createActivity", { methods: ["POST"], route: "activities", authLevel: "anonymous",
  handler: wrap(async req => h().createActivity(headersOf(req), await jsonBody(req))) });

app.http("addOption", { methods: ["POST"], route: "activities/{id}/options", authLevel: "anonymous",
  handler: wrap(async req => h().addOption(headersOf(req), req.params.id, await jsonBody(req))) });

app.http("deleteActivity", { methods: ["DELETE"], route: "activities/{id}", authLevel: "anonymous",
  handler: wrap(async req => h().deleteActivity(headersOf(req), req.params.id)) });

app.http("vote", { methods: ["PUT"], route: "vote", authLevel: "anonymous",
  handler: wrap(async req => h().vote(headersOf(req), await jsonBody(req))) });

app.http("uploadImage", { methods: ["POST"], route: "images", authLevel: "anonymous",
  handler: wrap(async req => h().uploadImage(headersOf(req), Buffer.from(await req.arrayBuffer()), req.headers.get("content-type"))) });

app.http("getImage", { methods: ["GET"], route: "images/{id}", authLevel: "anonymous",
  handler: wrap(async req => h().getImage(req.params.id)) });
