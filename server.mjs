/**
 * PBB main-feed relay + static host.
 *
 * Why this exists: pbbcollab.live signs a per-session stream path and answers
 * 403 to any request whose Referer is not its own origin, so a local page can
 * never hotlink the manifest or the segments. This process does the handshake
 * server-side, holds the ClearKey pair, and re-serves the stream under a stable
 * path that the player can fetch from any origin.
 *
 * Routes
 *   GET /api/main                -> { cam, mpd, kid, key, expiresAt }
 *   GET /api/ext                 -> same, for the Extra camera
 *   GET /pbb/main/manifest.mpd   -> live MPD (stable URL, auto-refreshed session)
 *   GET /pbb/main/<segment>      -> init + media segments
 *   GET /pbb/ext/...             -> same for Extra
 *   *                            -> static files from this directory
 *
 * Run: node server.mjs            (PORT=8787 by default)
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const ORIGIN = "https://www.pbbcollab.live";
const SESSION_URL = ORIGIN + "/api/streams/session";

/* iWant issues a fresh, 60-second signed manifest URL per playback start. */
const IWANT_API = "https://api.iwanttfc.com/entitlement/playback/start/";
const IWANT_CONTENT = "54bbba0c-ada2-41ec-ba51-05e6de5e8305";
const IWANT_COUNTRY = "PH";
const IWANT_PLATFORM = "web";
const IWANT_SUBPLATFORM = "browser";
const IWANT_APP_VERSION = "26.11.20-1";
const IWANT_DEVICE_ID = "1654141842111001252";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

/* Camera id used by the site's session payload. Server map is fixed to s1. */
const CAMS = new Set(["all", "ext", "din", "main"]);

/* ------------------------------------------------------------------ */
/* Session handshake                                                   */
/* ------------------------------------------------------------------ */

/* Mirrors the site's buildRandomizedSessionPayload(): the server expects a
 * random hex key plus a timestamp/tag blob XORed with that key and 0x3C. */
function sessionPayload() {
  const r = randomBytes(13);
  let k = "";
  for (let i = 0; i < 12; i++) k += r[i].toString(16).padStart(2, "0");
  const mode = 0; // s1
  const tag = (r[12] & 0xf8) | ((mode ^ (r[0] & 7)) & 7);
  const now = Math.floor(Date.now() / 1000);
  const raw =
    tag.toString(16).padStart(2, "0") +
    ":" +
    k.slice(0, 8) +
    ":" +
    now.toString(16).padStart(8, "0");
  let x = "";
  for (let i = 0; i < raw.length; i++) {
    x += String.fromCharCode(raw.charCodeAt(i) ^ k.charCodeAt(i % k.length) ^ 0x3c);
  }
  return JSON.stringify({ k, v: Buffer.from(x, "latin1").toString("base64") });
}

/* token = base64( kid + ":" + key ) XOR 0x5A XOR nonce */
function decodeToken(tokenB64, nonce) {
  const raw = Buffer.from(tokenB64, "base64");
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw[i] ^ 0x5a ^ nonce.charCodeAt(i % nonce.length));
  }
  const sep = out.indexOf(":");
  return { kid: out.slice(0, sep), key: out.slice(sep + 1) };
}

const sessions = new Map(); // cam -> { dir, kid, key, expiresAt }
const iwantFeeds = new Map(); // content id -> { url, segQuery, expiresAt, content }

async function fetchIwant(content) {
  const id = content || IWANT_CONTENT;
  const psid = randomUUID();
  const body = {
    platform: IWANT_PLATFORM,
    subPlatform: IWANT_SUBPLATFORM,
    appVersion: IWANT_APP_VERSION,
    appVersionCode: 1,
    playbackSessionId: psid,
    playbackCapabilities: {
      drm: ["widevine", "clearkey", "fairplay"],
      streamType: ["dash", "hls"],
      resolution: ["fhd"],
      audio: ["stereo"],
      hdr: ["hdr10"],
    },
    deviceId: IWANT_DEVICE_ID,
    referralProperties: {},
  };
  const url =
    IWANT_API + id +
    "?offline=false&country=" + IWANT_COUNTRY +
    "&contentId=" + id +
    "&platform=" + IWANT_PLATFORM +
    "&subPlatform=" + IWANT_SUBPLATFORM;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-country-code": IWANT_COUNTRY,
      "x-device-platform": IWANT_PLATFORM,
      "X-Device-SubPlatform": IWANT_SUBPLATFORM,
      "X-IW-UserAgent": UA,
      origin: "https://www.iwanttfc.com",
      referer: "https://www.iwanttfc.com/",
      "user-agent": UA,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`iwant playback/start failed (${res.status})`);
  const data = await res.json();
  const mpd = data && data.playbackInfo && data.playbackInfo.url;
  if (!mpd) throw new Error("iwant returned no playback URL");
  return { url: mpd, content: id, expiresAt: Date.now() + 30000 };
}

async function iwant(content, force) {
  const key = content || IWANT_CONTENT;
  const hit = iwantFeeds.get(key);
  if (!force && hit && Date.now() < hit.expiresAt) return hit;
  const feed = await fetchIwant(key);
  iwantFeeds.set(key, feed);
  return feed;
}

/* The signed query has to ride along on every segment request, not just the
 * MPD — that's how the CDN authorises init and media files. */
async function iwantUpstream(content, relPath) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const feed = await iwant(content, attempt > 0);
    const signed = new URL(feed.url);
    let url, isManifest = relPath === "manifest.mpd";
    if (isManifest) {
      url = feed.url;
    } else {
      const base = signed.origin + signed.pathname.slice(0, signed.pathname.lastIndexOf("/") + 1);
      url = base + relPath + (feed.segQuery || "");
    }
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: "*/*", referer: "https://www.iwanttfc.com/", "user-agent": UA },
      });
    } catch (e) {
      lastErr = e;
      continue;
    }
    /* Each MPD carries a separate hdntl token for the segment URLs. That is
     * the one authorising init/media files — the manifest's own hdnts does
     * not. Cache it so the next segment requests can use it. */
    if (isManifest && res.ok) {
      const text = await res.text();
      const m = text.match(/[?&]hdntl=[^"<>\s]+/);
      if (m) {
        feed.segQuery = "?" + m[0].replace(/^[?&]/, "");
        iwantFeeds.set(content || IWANT_CONTENT, feed);
      }
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/dash+xml; charset=utf-8" },
      });
    }
    if (res.status === 403 || res.status === 404) {
      lastErr = new Error(`iwant upstream ${res.status}`);
      iwantFeeds.delete(content || IWANT_CONTENT);
      continue;
    }
    return res;
  }
  throw lastErr || new Error("iwant upstream failed");
}

/* Local guest chat so the page's own UI has a backend when self-hosted.
 * In-memory only: a restart clears history, which is fine for one box. */
const chatLog = [];
const chatSeen = new Map(); // sid -> last post ms (slow-mode)

function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

async function fetchSession(cam) {
  const res = await fetch(SESSION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pbb-client": "v3",
      accept: "*/*",
      origin: ORIGIN,
      referer: ORIGIN + "/",
      "user-agent": UA,
      "accept-language": "en-US,en;q=0.9",
    },
    body: sessionPayload(),
  });
  if (!res.ok) throw new Error(`session handshake failed (${res.status})`);
  const data = await res.json();
  const desc = data && data.streams && data.streams[cam];
  if (!desc || !desc.endpoint) {
    throw new Error(`camera "${cam}" unavailable${data && data.maintenance ? " (maintenance)" : ""}`);
  }
  const { kid, key } = decodeToken(desc.token, data.nonce);
  const dir = desc.endpoint.slice(0, desc.endpoint.lastIndexOf("/") + 1);
  const ttlMs = Math.min(Number(data.expiresInSec || 3600) * 1000, 3 * 60 * 60 * 1000);
  return { dir, kid, key, expiresAt: Date.now() + ttlMs * 0.8 };
}

async function session(cam, force) {
  const hit = sessions.get(cam);
  if (!force && hit && Date.now() < hit.expiresAt) return hit;
  const fresh = await fetchSession(cam);
  sessions.set(cam, fresh);
  return fresh;
}

/* ------------------------------------------------------------------ */
/* Upstream proxy                                                      */
/* ------------------------------------------------------------------ */

/* One retry with a freshly minted session covers the case where the site
 * rotates the stream directory while we still hold the old one. */
async function upstream(cam, relPath) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await session(cam, attempt > 0);
    const url = ORIGIN + s.dir + relPath;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: "*/*",
          origin: ORIGIN,
          referer: ORIGIN + "/",
          "user-agent": UA,
        },
      });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.status === 403 || res.status === 404) {
      lastErr = new Error(`upstream ${res.status}`);
      sessions.delete(cam);
      continue;
    }
    return res;
  }
  throw lastErr || new Error("upstream failed");
}

async function pipe(res, upstreamRes) {
  const buf = Buffer.from(await upstreamRes.arrayBuffer());
  res.writeHead(upstreamRes.status, {
    "content-type": upstreamRes.headers.get("content-type") || "application/octet-stream",
    "content-length": buf.length,
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(buf);
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, rel);
  if (!target.startsWith(ROOT)) return notFound(res);
  let info;
  try {
    info = await stat(target);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  const body = await readFile(target);
  res.writeHead(200, {
    "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      // Chrome's local-network guard preflights public https -> 127.0.0.1.
      "access-control-allow-private-network": "true",
    });
    return res.end();
  }

  try {
    if (pathname === "/api/chat") {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.text !== "string") return json(res, 400, { error: "bad message" });
        const text = body.text.trim().slice(0, 160);
        if (!text) return json(res, 400, { error: "empty message" });
        const sid = String(body.sid || "").slice(0, 40);
        const last = chatSeen.get(sid) || 0;
        if (Date.now() - last < 4000) return json(res, 429, { error: "slow mode — 4s" });
        chatSeen.set(sid, Date.now());
        chatLog.push({
          name: String(body.name || "Guest").slice(0, 24),
          text,
          ts: Date.now(),
        });
        if (chatLog.length > 200) chatLog.splice(0, chatLog.length - 200);
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { messages: chatLog.slice(-80) });
    }

    if (pathname === "/api/viewers" || pathname === "/api/viewers/active") {
      return json(res, 200, { count: 1 });
    }

    // Session descriptor for the page: stable MPD path plus the ClearKey pair.
    const api = pathname.match(/^\/api\/(all|ext|din|main)$/);
    if (api) {
      const cam = api[1];
      const s = await session(cam, false);
      return json(res, 200, {
        cam,
        mpd: `/pbb/${cam}/manifest.mpd`,
        kid: s.kid,
        key: s.key,
        expiresAt: s.expiresAt,
      });
    }

    if (pathname === "/api/iwant") {
      const content = url.searchParams.get("content") || IWANT_CONTENT;
      const feed = await iwant(content, false);
      return json(res, 200, {
        cam: "iwant",
        mpd: `/pbb/iwant/${content}/manifest.mpd`,
        content: feed.content,
        url: feed.url,
        segQuery: feed.segQuery,
        expiresAt: feed.expiresAt,
      });
    }

    const iwantStream = pathname.match(/^\/pbb\/iwant\/([0-9a-f-]{36})\/(.+)$/);
    if (iwantStream) {
      const rest = iwantStream[2];
      if (rest.includes("..")) return notFound(res);
      return pipe(res, await iwantUpstream(iwantStream[1], rest));
    }

    const iwantLegacy = pathname.match(/^\/pbb\/iwant\/(.+)$/);
    if (iwantLegacy) {
      const rest = iwantLegacy[1];
      if (rest.includes("..")) return notFound(res);
      return pipe(res, await iwantUpstream(IWANT_CONTENT, rest));
    }

    const stream = pathname.match(/^\/pbb\/(all|ext|din|main)\/(.+)$/);
    if (stream) {
      const cam = stream[1];
      if (!CAMS.has(cam)) return notFound(res);
      const rest = stream[2];
      if (rest.includes("..")) return notFound(res);
      const up = await upstream(cam, rest);
      return pipe(res, up);
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(res, pathname);
    return notFound(res);
  } catch (e) {
    json(res, 502, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`PBB relay on http://127.0.0.1:${PORT}`);
  // Warm both feeds so the first play has a session ready.
  Promise.allSettled([
    session("main", false),
    session("ext", false),
    iwant(IWANT_CONTENT, false),
  ]).then((r) => {
    for (const s of r) if (s.status === "rejected") console.log("warm:", s.reason.message);
  });
});
