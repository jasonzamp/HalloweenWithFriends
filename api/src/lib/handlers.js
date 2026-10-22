// Request handlers, kept free of the Functions runtime so they can be tested directly.
const crypto = require("crypto");
const { grabLinkImage, PreviewError } = require("./linkimage");

const LIMITS = { title: 80, price: 20, url: 500, desc: 600, optLabel: 60, name: 30, options: 12, imageBytes: 4 * 1024 * 1024 };
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const IMG_ID_RE = /^[0-9a-f-]{36}$/;
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
function cleanWhen(v) {
  v = String(v ?? "").trim(); if (!v) return "";
  const m = v.match(WHEN_RE);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || (m[4] && (+m[4] > 23 || +m[5] > 59))) throw new HttpError(400, "That date doesn't look right.");
  return v;
}
const ID_RE = /^[A-Za-z0-9-]{6,64}$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => new HttpError(400, m);

const newId = () => crypto.randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function voterIdOf(headers) {
  const id = headers["x-voter-id"] || "";
  if (!ID_RE.test(id)) throw bad("Missing or invalid voter id. Reload the page and try again.");
  return id;
}
function cleanUrl(u) {
  u = str(u, LIMITS.url);
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw 0; return x.href; }
  catch { throw bad("That link doesn't look like a web address."); }
}
const softUrl = u => { try { return cleanUrl(u); } catch { return ""; } };
const imgId = v => { v = str(v, 64); return IMG_ID_RE.test(v) ? v : ""; };
function optionOf(o, voterId, name, at) {
  return { label: str(o?.label, LIMITS.optLabel), price: str(o?.price, LIMITS.price), imageId: imgId(o?.imageId), url: softUrl(o?.url), by: voterId, byName: name, at };
}
function cleanOptions(list, voterId, name) {
  const out = {};
  let at = Date.now();
  for (const o of (Array.isArray(list) ? list : []).slice(0, LIMITS.options)) {
    const opt = optionOf(o, voterId, name, at++);
    if (opt.label) out[newId()] = opt;
  }
  return out;
}
const publicAct = ({ etag, ...a }) => a;

function makeHandlers(store, { adminCode = "", grab = url => grabLinkImage(url) } = {}) {
  const isAdmin = headers => !!adminCode && headers["x-admin-code"] === adminCode;

  return {
    async state() {
      const [activities, votes] = await Promise.all([store.listActivities(), store.listVotes()]);
      return { status: 200, body: { activities: activities.map(publicAct), votes } };
    },

    async createActivity(headers, body) {
      const voterId = voterIdOf(headers);
      const name = str(body?.name, LIMITS.name);
      const title = str(body?.title, LIMITS.title);
      if (!title) throw bad("Give the activity a name.");
      const imageId = str(body?.imageId, 64);
      if (imageId && !ID_RE.test(imageId)) throw bad("Invalid image.");
      const a = {
        id: newId(), title, when: cleanWhen(body?.when), price: "", url: cleanUrl(body?.url),
        desc: str(body?.desc, LIMITS.desc), imageId, options: cleanOptions(body?.options, voterId, name),
        createdBy: voterId, createdByName: name, createdAt: Date.now(),
      };
      await store.createActivity(a);
      return { status: 201, body: a };
    },

    async addOption(headers, actId, body) {
      const voterId = voterIdOf(headers);
      const label = str(body?.label, LIMITS.optLabel);
      if (!label) throw bad("Type the option first.");
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = await store.getActivity(actId);
        if (!a) throw new HttpError(404, "That activity was removed.");
        if (Object.keys(a.options).length >= 30) throw bad("That activity already has plenty of options.");
        const oid = newId();
        a.options[oid] = optionOf({ ...body, label }, voterId, str(body?.name, LIMITS.name), Date.now());
        try { await store.replaceActivity(a, a.etag); return { status: 200, body: publicAct(a) }; }
        catch (e) { if (e.statusCode !== 412) throw e; }
      }
      throw new HttpError(409, "Someone else was editing at the same time. Try again.");
    },

    async setOptionImage(headers, actId, optId, body) {
      const voterId = voterIdOf(headers);
      const imageId = imgId(body?.imageId);
      if (!imageId) throw bad("Pick a picture first.");
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = await store.getActivity(actId);
        if (!a) throw new HttpError(404, "That activity was removed.");
        const o = a.options[optId];
        if (!o) throw new HttpError(404, "That option was removed.");
        if (o.imageId && o.by !== voterId && a.createdBy !== voterId && !isAdmin(headers))
          throw new HttpError(403, "Only the person who added this option can change its poster.");
        o.imageId = imageId;
        try { await store.replaceActivity(a, a.etag); return { status: 200, body: publicAct(a) }; }
        catch (e) { if (e.statusCode !== 412) throw e; }
      }
      throw new HttpError(409, "Someone else was editing at the same time. Try again.");
    },

    async setWhen(headers, actId, body) {
      const voterId = voterIdOf(headers);
      const when = cleanWhen(body?.when);
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = await store.getActivity(actId);
        if (!a) throw new HttpError(404, "That activity was removed.");
        if (a.createdBy !== voterId && !isAdmin(headers)) throw new HttpError(403, "Only the person who added this activity can change its date.");
        a.when = when;
        try { await store.replaceActivity(a, a.etag); return { status: 200, body: publicAct(a) }; }
        catch (e) { if (e.statusCode !== 412) throw e; }
      }
      throw new HttpError(409, "Someone else was editing at the same time. Try again.");
    },

    async deleteActivity(headers, actId) {
      const voterId = voterIdOf(headers);
      const a = await store.getActivity(actId);
      if (!a) return { status: 204 };
      if (a.createdBy !== voterId && !isAdmin(headers)) throw new HttpError(403, "Only the person who added this can remove it.");
      await store.deleteActivity(actId);
      return { status: 204 };
    },

    async vote(headers, body) {
      const voterId = voterIdOf(headers);
      const name = str(body?.name, LIMITS.name);
      if (!name) throw bad("Tell us your name first.");
      const going = {}, picks = {};
      for (const [k, v] of Object.entries(body?.going || {}).slice(0, 200)) if (ID_RE.test(k) && v === true) going[k] = true;
      for (const [k, v] of Object.entries(body?.picks || {}).slice(0, 200)) if (ID_RE.test(k) && typeof v === "string" && ID_RE.test(v)) picks[k] = v;
      await store.putVote({ voterId, name, going, picks });
      return { status: 200, body: { voterId, name, going, picks } };
    },

    async uploadImage(headers, rawBody, contentType) {
      voterIdOf(headers);
      const type = String(contentType || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) throw bad("Only JPG, PNG, WebP or GIF images can be uploaded.");
      if (!rawBody?.length) throw bad("The image was empty.");
      if (rawBody.length > LIMITS.imageBytes) throw bad("That image is too big. Try a smaller screenshot.");
      const id = crypto.randomUUID();
      await store.putImage(id, rawBody, type);
      return { status: 201, body: { id } };
    },

    async preview(headers, body) {
      voterIdOf(headers);
      const url = cleanUrl(body?.url);
      if (!url) throw bad("Paste a link first.");
      let img;
      try { img = await grab(url); }
      catch (e) { if (e instanceof PreviewError) throw new HttpError(422, e.message); throw new HttpError(422, "Couldn't grab a picture from that link. Add one yourself instead."); }
      const id = crypto.randomUUID();
      await store.putImage(id, img.buffer, img.contentType);
      return { status: 201, body: { id } };
    },

    async getImage(id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) return { status: 404 };
      const img = await store.getImage(id);
      if (!img) return { status: 404 };
      return { status: 200, raw: img.buffer, headers: { "content-type": img.contentType, "cache-control": "public, max-age=31536000, immutable" } };
    },
  };
}

module.exports = { makeHandlers, HttpError };
