# RadioT in FiveM

`integrations/fivem/radiot` is a drop-in FiveM resource that turns RadioT into the in-game radio.
Players hear the same song at the same moment as the website, and a now-playing card (cover, title, requester,
progress) slides in on every track change.

## How it works

- **server.lua** polls `GET {ApiUrl}/api/public/station` every `Config.PollSeconds` and pushes
  changes to every player. The API sees one request per game server, not per player.
- **client.lua** decides when to play (radio on, and in a vehicle if `Config.VehicleOnly`), mutes
  GTA's own radio while RadioT plays, and handles commands, key bindings and saved volume.
- **html/** is the NUI page. Like the website, it plays the on-air file straight from storage at
  the station's shared position (corrected for the relay delay), switches to the announced next
  track at its start time, and shows the now-playing card. Leaving the vehicle stops the download,
  so idle players use no bandwidth.

Listening only: requests, votes and chat stay on the website.

## Install

1. Copy `integrations/fivem/radiot` into your server's `resources/` folder.
2. Edit `config.lua`:
   - `Config.ApiUrl`: your API, e.g. `https://api.radiot.app` (local dev: `http://localhost:4000`).
3. Add `ensure radiot` to `server.cfg` and restart.

Audio files are served from Vercel Blob's public CDN, so players' machines can always reach them.
In-game playback switches tracks with a short cut rather than the website's crossfade.

## Player controls

| Action           | Default         | Command                                |
| ---------------- | --------------- | -------------------------------------- |
| Radio on/off     | `F9`            | `/radiot`, `/radiot on`, `/radiot off` |
| Volume up / down | `PgUp` / `PgDn` | `/radiot vol 0-100`                    |

Players can rebind keys in _Settings → Key Bindings → FiveM_. On/off and volume are remembered per
player.

## Public station API

`GET /api/public/station` needs no auth, is CORS-open and is cached for 3 s:

```json
{
  "name": "RadioT",
  "now": {
    "kind": "request",
    "title": "…",
    "artist": "…",
    "artworkUrl": "…",
    "durationMs": 201000,
    "startedAt": "2026-11-15T13:00:00.000Z",
    "requester": { "name": "…" },
    "media": {
      "url": "https://…blob.vercel-storage.com/cooked/…mp3",
      "cueInMs": 1200,
      "cueOutMs": 205000,
      "gainDb": -2.1,
      "crossfadeMs": 5000
    },
    "…": "…"
  },
  "next": { "title": "…", "startsAt": "2026-11-15T13:03:15.000Z", "media": { "…": "…" } },
  "elapsedSeconds": 42,
  "listeners": 12,
  "serverTime": "2026-11-15T13:00:42.000Z"
}
```

`listeners` counts website listeners only.
