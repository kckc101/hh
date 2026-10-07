# E-Rave Cambodia — Multiplayer Server 🎧🇰🇭

Node + Express + Socket.io backend for **E-Rave Cambodia**. The web client lives in **[kckc101/nh](https://github.com/kckc101/nh)**.

## What it does

- **Presence:** players join with their avatar. Positions, dances and moves are broadcast as compact 10 Hz snapshots.
- **Chat and reactions:** rate-limited, with the last 40 messages kept for newcomers.
- **DJ host mode:** the password is checked on the server. It controls the shared playlist (play / pause / next / queue / reorder / BPM), stage FX and announcements.
- **Synced playback:** clients get `{ track, startedAt }` and seek using an NTP-style time sync. Built-in tracks auto-advance.
- **Uploads:** `POST /api/upload` (DJ only) stores mp3/wav/ogg/m4a/aac/flac/opus/webm files in `uploads/`, served at `/uploads/*`.
- **Live mic:** relays WebRTC signalling (DJ → listeners mesh).

## Run

```bash
npm install
npm run dev     # watch mode, http://localhost:3001
npm start       # production
```

Then run the web client (`npm run dev` in kckc101/nh). Its Vite dev server proxies to this server.

## Deploy (Render)

GitHub Pages can't run Node, so the server needs a Node host with WebSocket support. `render.yaml` sets this up on Render's free tier:

1. On render.com, sign in with GitHub and allow access to `kckc101/hh`.
2. Go to **New → Blueprint**, pick `kckc101/hh`, enter a `DJ_PASSWORD`, and click **Apply**.
3. Copy the service URL (e.g. `https://e-rave-server.onrender.com`). Set it as the Actions variable `VITE_SERVER_URL` in `kckc101/nh`, then re-run its Pages workflow.

Free-tier notes:
- The service sleeps after about 15 minutes idle. The first visitor waits about a minute for it to wake; refresh if the page falls back to the offline demo.
- Uploaded tracks are lost when it restarts.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + Socket.io port |
| `DJ_PASSWORD` | `erave2026` | Host password. **Change it for any public deployment.** |
| `STATIC_DIR` | `dist` | Folder with the built web client to serve from the same origin, e.g. `../nh/dist` |
| `UPLOAD_DIR` | `./uploads` | Where uploaded tracks are stored |

`/api/*` and `/uploads/*` send CORS headers, and Socket.io accepts any origin, so the web client can be hosted on another domain (set `VITE_SERVER_URL` there).

## Layout

```
server/index.js   HTTP routes, Socket.io events, playlist ticker
shared/dj.js      Playlist state machine (same file as in the web client repo)
```

## Socket events

Client → server: `join`, `state`, `emote`, `react`, `chat`, `avatar`, `time`, `track:ended`, `dj:auth`, and for the DJ: `dj` (`play` `pause` `resume` `toggle` `next` `prev` `add` `remove` `move` `bpm`), `dj:fx`, `dj:announce`, `rtc:live`, `rtc:request`, `rtc:signal`.

Server → client: `hello`, `online`, `players`, `player:join`, `player:leave`, `player:avatar`, `player:emote`, `react`, `chat`, `dj:state`, `fx`, `announce`, `rtc:live`, `rtc:request`, `rtc:signal`.
