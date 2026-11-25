/**
 * Standalone PBB relay — Cloudflare Worker.
 * No Node, no localhost, no GitHub. Paste into a Worker and Deploy.
 *
 * Endpoints:
 *   GET /api/iwant?content=<id>
 *   GET /pbb/iwant/<id>/manifest.mpd
 *   GET /pbb/iwant/<id>/<segment>
 */

const IWANT_API = "https://api.iwanttfc.com/entitlement/playback/start/";
const DEFAULT_CONTENT = "54bbba0c-ada2-41ec-ba51-05e6de5e8305";
const COUNTRY = "PH";
const DEVICE_ID = "1654141842111001252";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const feeds = new Map(); // content -> { url, segQuery, expiresAt }
const sessions = new Map(); // pbbcollab cam -> { dir, kid, key, cookie, expiresAt }

const PB_ORIGIN = "https://www.pbbcollab.live";
const PB_SESSION = PB_ORIGIN + "/api/streams/session";
const PB_CAMS = new Set(["all", "ext", "din", "main"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ---- pbbcollab session relay (Extra / Extra Task) ---- */
function sessionPayload() {
  const r = crypto.getRandomValues(new Uint8Array(13));
  let k = "";
  for (let i = 0; i < 12; i++) k += r[i].toString(16).padStart(2, "0");
  const tag = (r[12] & 0xf8) | ((0 ^ (r[0] & 7)) & 7);
  const sec = Math.floor(Date.now() / 1000);
  const raw =
    tag.toString(16).padStart(2, "0") + ":" + k.slice(0, 8) + ":" +
    sec.toString(16).padStart(8, "0");
  let x = "";
  for (let i = 0; i < raw.length; i++) {
    x += String.fromCharCode(raw.charCodeAt(i) ^ k.charCodeAt(i % k.length) ^ 0x3c);
  }
  return JSON.stringify({ k, v: btoa(x) });
}

function decodeToken(tokenB64, nonce) {
  const bin = atob(tokenB64);
  let out = "";
  for (let i = 0; i < bin.length; i++) {
    out += String.fromCharCode(bin.charCodeAt(i) ^ 0x5a ^ nonce.charCodeAt(i % nonce.length));
  }
  const sep = out.indexOf(":");
  return { kid: out.slice(0, sep), key: out.slice(sep + 1) };
}

async function pbSession(cam, force) {
  const hit = sessions.get(cam);
  if (!force && hit && Date.now() < hit.expiresAt) return hit;
  const res = await fetch(PB_SESSION, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pbb-client": "v3",
      accept: "*/*",
      origin: PB_ORIGIN,
      referer: PB_ORIGIN + "/",
      "user-agent": UA,
    },
    body: sessionPayload(),
  });
  if (!res.ok) throw new Error(`session handshake ${res.status}`);
  const data = await res.json();
  const desc = data && data.streams && data.streams[cam];
  if (!desc || !desc.endpoint) throw new Error(`camera ${cam} unavailable`);
  const { kid, key } = decodeToken(desc.token, data.nonce);
  const dir = desc.endpoint.slice(0, desc.endpoint.lastIndexOf("/") + 1);
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const ttl = Math.min(Number(data.expiresInSec || 3600) * 1000, 3 * 60 * 60 * 1000);
  const feed = { dir, kid, key, cookie, expiresAt: Date.now() + ttl * 0.8 };
  sessions.set(cam, feed);
  return feed;
}

async function pbUpstream(cam, rest) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await pbSession(cam, attempt > 0);
    const res = await fetch(PB_ORIGIN + s.dir + rest, {
      headers: {
        accept: "*/*",
        origin: PB_ORIGIN,
        referer: PB_ORIGIN + "/",
        "user-agent": UA,
        ...(s.cookie ? { cookie: s.cookie } : {}),
      },
    });
    if (res.ok) {
      return new Response(res.body, {
        status: 200,
        headers: { ...CORS, "content-type": res.headers.get("content-type") || "video/mp4", "cache-control": "no-store" },
      });
    }
    last = new Error(`upstream ${res.status}`);
    sessions.delete(cam);
  }
  throw last || new Error("upstream failed");
}

/* ---- iWant playback ---- */
async function mint(content) {
  const payload = {
    platform: "web",
    subPlatform: "browser",
    appVersion: "26.11.20-1",
    appVersionCode: 1,
    playbackSessionId: crypto.randomUUID(),
    playbackCapabilities: {
      drm: ["widevine", "clearkey", "fairplay"],
      streamType: ["dash", "hls"],
      resolution: ["fhd"],
      audio: ["stereo"],
      hdr: ["hdr10"],
    },
    deviceId: DEVICE_ID,
    referralProperties: {},
  };
  const url =
    IWANT_API + content +
    "?offline=false&country=" + COUNTRY +
    "&contentId=" + content +
    "&platform=web&subPlatform=browser";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-country-code": COUNTRY,
      "x-device-platform": "web",
      "X-Device-SubPlatform": "browser",
      "X-IW-UserAgent": UA,
      origin: "https://www.iwanttfc.com",
      referer: "https://www.iwanttfc.com/",
      "user-agent": UA,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`playback/start ${res.status}`);
  const data = await res.json();
  const mpd = data && data.playbackInfo && data.playbackInfo.url;
  if (!mpd) throw new Error("no playback URL");
  const feed = { url: mpd, segQuery: "", expiresAt: Date.now() + 30000 };
  feeds.set(content, feed);
  return feed;
}

function feedFor(content, force) {
  const hit = feeds.get(content);
  return !force && hit && Date.now() < hit.expiresAt ? hit : mint(content);
}

async function manifest(content, feed) {
  const res = await fetch(feed.url, {
    headers: { accept: "*/*", referer: "https://www.iwanttfc.com/", "user-agent": UA },
  });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const text = await res.text();
  const m = text.match(/[?&]hdntl=[^"<>\s]+/);
  if (m) {
    feed.segQuery = "?" + m[0].replace(/^[?&]/, "");
    feeds.set(content, feed);
  }
  return new Response(text, {
    status: 200,
    headers: { ...CORS, "content-type": "application/dash+xml; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const pbApi = path.match(/^\/api\/(all|ext|din|main)$/);
      if (pbApi) {
        const cam = pbApi[1];
        const s = await pbSession(cam, false);
        return json({ cam, mpd: `/pbb/${cam}/manifest.mpd`, kid: s.kid, key: s.key, expiresAt: s.expiresAt });
      }

      const pbStream = path.match(/^\/pbb\/(all|ext|din|main)\/(.+)$/);
      if (pbStream) {
        const cam = pbStream[1];
        if (!PB_CAMS.has(cam)) return new Response("not found", { status: 404 });
        const rest = pbStream[2];
        if (rest.includes("..")) return new Response("not found", { status: 404 });
        return await pbUpstream(cam, rest);
      }

      if (path === "/api/iwant") {
        const content = url.searchParams.get("content") || DEFAULT_CONTENT;
        const f = await feedFor(content, false);
        return json({
          cam: "iwant",
          mpd: `/pbb/iwant/${content}/manifest.mpd`,
          content,
          url: f.url,
          expiresAt: f.expiresAt,
        });
      }

      const m = path.match(/^\/pbb\/iwant\/([0-9a-f-]{36})\/(.+)$/);
      if (m) {
        const content = m[1];
        const rest = m[2];
        if (rest.includes("..")) return new Response("not found", { status: 404 });
        let f = await feedFor(content, false);
        if (rest === "manifest.mpd") return manifest(content, f);

        if (!f.segQuery) {
          await manifest(content, f);
          f = feeds.get(content) || f;
        }
        const signed = new URL(f.url);
        const base = signed.origin + signed.pathname.slice(0, signed.pathname.lastIndexOf("/") + 1);
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch(base + rest + f.segQuery, {
            headers: { accept: "*/*", referer: "https://www.iwanttfc.com/", "user-agent": UA },
          });
          if (res.ok) {
            return new Response(res.body, {
              status: 200,
              headers: {
                ...CORS,
                "content-type": res.headers.get("content-type") || "video/mp4",
                "cache-control": "no-store",
              },
            });
          }
          f = await mint(content);
          await manifest(content, f);
          f = feeds.get(content) || f;
        }
        return new Response("upstream failed", { status: 502, headers: CORS });
      }

      return new Response("not found", { status: 404, headers: CORS });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};
