// Finds the preview picture of a web page (the og:image / twitter:image that WhatsApp shows) and downloads it.
// Guards against being pointed at private addresses, huge files and slow sites.
const dns = require("dns").promises;
const net = require("net");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 HalloweenWithFriends-LinkPreview/1.0";
const MAX_HTML = 1.5 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

class PreviewError extends Error {}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

async function assertPublic(u, { allowPrivate }) {
  if (!/^https?:$/.test(u.protocol)) throw new PreviewError("Only web links (http/https) work.");
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new PreviewError("Couldn't find that website."); });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new PreviewError("That link can't be used.");
}

async function safeFetch(url, opts, { allowPrivate, hops = 4 } = {}) {
  let u = new URL(url);
  for (let i = 0; i <= hops; i++) {
    await assertPublic(u, { allowPrivate });
    const r = await fetch(u, { ...opts, redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location"), u); continue; }
    return { res: r, finalUrl: u };
  }
  throw new PreviewError("That link redirects too many times.");
}

async function readCapped(res, max) {
  const reader = res.body?.getReader(); if (!reader) return { buf: Buffer.alloc(0), truncated: false };
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel().catch(() => {}); return { buf: Buffer.concat(chunks), truncated: true }; }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// Returns candidate image URLs in order of preference.
function findImages(html, base) {
  const out = [];
  const head = html.slice(0, 600000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const want = ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"];
  const found = {};
  for (const m of metas) {
    const key = (m.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    const val = (m.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && val && want.includes(key) && !found[key]) found[key] = decode(val.trim());
    if (key === "image" && val && !found.itemprop) found.itemprop = decode(val.trim());
  }
  for (const k of [...want, "itemprop"]) if (found[k]) out.push(found[k]);
  const link = head.match(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/i);
  if (link) { const h = (link[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1]; if (h) out.push(decode(h)); }
  // No preview picture declared: fall back to the first real photo on the page (skipping logos, icons and tracking pixels).
  if (!out.length) {
    for (const tag of (html.match(/<img\b[^>]*>/gi) || []).slice(0, 60)) {
      const src = (tag.match(/\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!src || src.startsWith("data:") || !/\.(jpe?g|png|webp|avif)(\?|$)/i.test(src)) continue;
      if (/logo|icon|sprite|avatar|pixel|badge|flag|payment|1x1/i.test(src + " " + tag)) continue;
      const w = Number((tag.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || 0);
      if (w && w < 300) continue;
      out.push(decode(src));
      if (out.length >= 3) break;
    }
  }
  const seen = new Set();
  return out.map(x => { try { return new URL(x, base).href; } catch { return null; } })
    .filter(x => x && /^https?:/.test(x) && !seen.has(x) && seen.add(x));
}

async function grabLinkImage(pageUrl, { allowPrivate = false } = {}) {
  let page;
  try { page = await safeFetch(pageUrl, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "en-GB,en;q=0.9" } }, { allowPrivate }); }
  catch (e) { if (e instanceof PreviewError) throw e; throw new PreviewError("That website didn't respond. Add a picture yourself instead."); }
  const { res, finalUrl } = page;
  if (!res.ok) throw new PreviewError(res.status === 403 || res.status === 429 ? "That website blocks picture grabbing. Add a screenshot instead." : "Couldn't open that page. Add a picture yourself instead.");
  const ctype = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

  // The link might point straight at an image.
  if (IMAGE_TYPES.has(ctype)) {
    const { buf, truncated } = await readCapped(res, MAX_IMAGE);
    if (truncated || !buf.length) throw new PreviewError("That picture is too big.");
    return { buffer: buf, contentType: ctype };
  }
  const { buf } = await readCapped(res, MAX_HTML);
  const candidates = findImages(buf.toString("utf8"), finalUrl);
  if (!candidates.length) throw new PreviewError("That page doesn't have a preview picture. Add a screenshot instead.");

  for (const src of candidates.slice(0, 3)) {
    try {
      const { res: ir } = await safeFetch(src, { headers: { "user-agent": UA, accept: "image/avif,image/webp,image/*;q=0.9", referer: finalUrl.href } }, { allowPrivate });
      const t = (ir.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!ir.ok || !IMAGE_TYPES.has(t)) continue;
      const { buf: img, truncated } = await readCapped(ir, MAX_IMAGE);
      if (truncated || img.length < 200) continue;
      return { buffer: img, contentType: t };
    } catch (e) { if (e instanceof PreviewError) continue; }
  }
  throw new PreviewError("Couldn't download that page's picture. Add a screenshot instead.");
}

module.exports = { grabLinkImage, findImages, isPrivateIp, PreviewError };
