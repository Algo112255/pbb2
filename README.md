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
GET /api/main                      -> { cam, mpd, kid, key, expiresAt }
GET /api/all | /api/ext | /api/din -> same for the other cameras
GET /pbb/<cam>/manifest.mpd        -> live MPD, session refreshed automatically
GET /pbb/<cam>/<segment>           -> init + media segments
```

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
| PBB Live   | `main`   | 1080p broadcast                        |
| Extra      | `all`    | House / daily show                     |
| Extra Task | `ext`    | Task room                              |
| 2 View     | both     | Main + whichever Extra source is active |

## Files

- `index.html` — player, chat dock, recorder. No build step.
- `server.mjs` — relay + static host, zero dependencies, Node 18+.
