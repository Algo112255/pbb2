# PBBLIVE.TOP

Two-camera live player for the PBB Collab 3.0 feeds, with a local relay that
does the `pbbcollab.live` session handshake for you.

## Why the relay

`pbbcollab.live` mints a per-session stream path at `POST /api/streams/session`
and answers **403** to any request whose `Referer` is not its own origin. A page
on another host cannot play the manifest or the segments directly. `server.mjs`
performs that handshake, decodes the ClearKey pair out of the session token, and
re-serves the stream under a stable path:

```
GET /api/iwant?content=<id>        -> signed feed for any iWant content id
GET /pbb/iwant/<id>/manifest.mpd   -> that feed's signed MPD
GET /pbb/iwant/<id>/<segment>      -> init + media with the MPD's hdntl token
```

## No-localhost option

`worker.js` is the same relay as a Cloudflare Worker. Create a Worker, paste it,
Deploy, then set one line in `index.html`:

```javascript
  var PBB_RELAY_URL = "https://<your-worker>.workers.dev";
```

After that nothing runs on your PC: no `node server.mjs`, no loopback permission,
no GitHub dependency for the stream. The page can live on any static host.

## Run

```bash
node server.mjs        # PORT=8787 by default
```

Then open <http://127.0.0.1:8787>.

The GitHub Pages build (<https://algo112255.github.io/pbb2/>) is static — it
still needs this relay running on the same machine, because the browser is
pointed at `http://127.0.0.1:8787` for the stream.

## Cameras

| Tab        | Site key | Notes                                  |
| ---------- | -------- | -------------------------------------- |
| PBB Live   | `iwant`  | iWant `/player/<id>` feed, 1080p, auto re-signed |
| Extra      | `all`    | House / daily show, via pbbcollab session relay       |
| Extra Task | `ext`    | Task room                              |
| 2 View     | both     | Main + whichever Extra source is active |

## Files

- `index.html` — player, chat dock, recorder. No build step.
- `server.mjs` — relay + static host, zero dependencies, Node 18+.
