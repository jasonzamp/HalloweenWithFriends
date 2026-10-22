// Storage layer: Azure Table Storage for activities and votes, Blob Storage for screenshots.
const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");

const ACT_TABLE = "activities";
const VOTE_TABLE = "votes";
const IMG_CONTAINER = "images";
const PK_ACT = "act";
const PK_VOTE = "vote";

function makeStore(connectionString, { prefix = "" } = {}) {
  prefix = String(prefix).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!connectionString) throw new Error("STORAGE_CONNECTION_STRING is not set");
  const opts = { allowInsecureConnection: /UseDevelopmentStorage|127\.0\.0\.1|localhost/i.test(connectionString) };
  const acts = TableClient.fromConnectionString(connectionString, prefix + ACT_TABLE, opts);
  const votes = TableClient.fromConnectionString(connectionString, prefix + VOTE_TABLE, opts);
  const blobs = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(IMG_CONTAINER);

  let ready = null;
  const ensure = () => (ready ||= Promise.all([
    acts.createTable().catch(ignoreExists),
    votes.createTable().catch(ignoreExists),
    blobs.createIfNotExists(),
  ]).catch(e => { ready = null; throw e; }));

  const toAct = e => ({
    id: e.rowKey, title: e.title, price: e.price || "", url: e.url || "", desc: e.desc || "",
    imageId: e.imageId || "", options: safeJson(e.options, {}), createdBy: e.createdBy || "",
    createdByName: e.createdByName || "", createdAt: Number(e.createdAt) || 0, etag: e.etag,
  });
  const fromAct = a => ({
    partitionKey: PK_ACT, rowKey: a.id, title: a.title, price: a.price, url: a.url, desc: a.desc,
    imageId: a.imageId, options: JSON.stringify(a.options || {}), createdBy: a.createdBy,
    createdByName: a.createdByName, createdAt: a.createdAt,
  });

  return {
    async listActivities() {
      await ensure();
      const out = [];
      for await (const e of acts.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK_ACT}'` } })) out.push(toAct(e));
      return out;
    },
    async getActivity(id) {
      await ensure();
      try { return toAct(await acts.getEntity(PK_ACT, id)); }
      catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async createActivity(a) { await ensure(); await acts.createEntity(fromAct(a)); },
    async replaceActivity(a, etag) { await ensure(); await acts.updateEntity(fromAct(a), "Replace", { etag }); },
    async deleteActivity(id) {
      await ensure();
      try { await acts.deleteEntity(PK_ACT, id); } catch (e) { if (e.statusCode !== 404) throw e; }
    },
    async listVotes() {
      await ensure();
      const out = [];
      for await (const e of votes.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK_VOTE}'` } })) {
        out.push({ voterId: e.rowKey, name: e.name || "", going: safeJson(e.going, {}), picks: safeJson(e.picks, {}) });
      }
      return out;
    },
    async putVote(v) {
      await ensure();
      await votes.upsertEntity({ partitionKey: PK_VOTE, rowKey: v.voterId, name: v.name, going: JSON.stringify(v.going), picks: JSON.stringify(v.picks) }, "Replace");
    },
    async putImage(id, buffer, contentType) {
      await ensure();
      await blobs.getBlockBlobClient(id).uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "public, max-age=31536000, immutable" } });
    },
    async getImage(id) {
      await ensure();
      try {
        const buf = await blobs.getBlockBlobClient(id).downloadToBuffer();
        const props = await blobs.getBlockBlobClient(id).getProperties();
        return { buffer: buf, contentType: props.contentType || "image/jpeg" };
      } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
  };
}

function ignoreExists(e) { if (e.statusCode !== 409) throw e; }
function safeJson(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

module.exports = { makeStore };
