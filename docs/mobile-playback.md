# Why mobile playback kept stopping

Written 2026-11-18, when playback moved from the browser to the server-side stream
(`docs/streaming.md`). All line numbers refer to the old browser player at commit `ef09b58`
(`apps/web/lib/player.ts`, `apps/web/lib/radio.tsx`), which is gone from the current code.

**How sure each finding is.** The old player was read line by line. Two mechanisms were also
reproduced in Playwright's Chromium and WebKit (they are marked _reproduced_). The rest follow
from that code plus documented browser behaviour (marked _from the code_). **Nothing here was
tested on a physical iPhone or Android phone**, because none was available; an iPhone and a
Pixel were only emulated.

## The root cause

The old player needed the page's JavaScript to run **at every track change**. Each song was a
separate MP3 on one of two `<audio>` elements, the next song was started and crossfaded by
timers, and the timeline came from polling and sockets. A phone that is locked, backgrounded or
changing networks throttles or suspends exactly that: timers, sockets and `play()` calls without
a tap. When the page's JavaScript pauses at the wrong moment, nothing starts the next song and
the music stops.

A single continuous stream has no track changes for the page to handle, so the audio element can
carry on by itself. That is the main reason for the redesign.

## What went wrong, in order of how likely it is to have caused real stops

### 1. Silence at the end of each track when the page was throttled (_from the code_)

`prepareNext()` arms two timers for every track (`player.ts:359-377`): one starts the crossfade
into the announced next track, one **pauses the deck at the track's cue-out** if no next track was
announced in time (`:373-375`, "stop cleanly at the cue-out"). The next-track announcement
arrives over a socket or the timeline poll, whose timer waits up to a minute
(`radio.tsx:96`, `Math.min(60_000, …)`). A hidden page's timers are throttled (Chrome limits them
to once a second, and to once a minute for pages hidden a few minutes) and a locked iOS page can
be suspended outright. If the announcement or the crossfade timer came late, the cue-out timer
paused the music. Coming back to the page only refreshed the timeline (`radio.tsx:156`,
`visibilitychange` → `refresh()`); it did not restart a deck that had been paused.

### 2. Audio routed through a Web Audio graph that the OS can suspend (_reproduced_)

Both decks were connected with `createMediaElementSource` into one `AudioContext`
(`player.ts:266-294`) for the crossfade gains. Once an element is routed this way, **its sound
only exists while the context runs**. The player called `ctx.resume()` once, inside the first tap
(`:196`) and never listened for the context's `statechange`. Safari on iOS is
documented to interrupt audio contexts when something else takes over audio (a call, Siri) and is
widely reported to suspend them in the background; an interrupted or suspended context needs a tap
to resume. That iOS behaviour could not be verified here (no iPhone), only that the old player had
no defence against it.

Measured with an element routed through a context that was then suspended (Playwright, 3 s):

| Browser  | Element position while the context is suspended | `paused` |
| -------- | ----------------------------------------------- | -------- |
| Chromium | did not move (0.00 s)                           | `false`  |
| WebKit   | kept advancing (+3.03 s)                        | `false`  |

In Chromium the element reports "playing" while time stands still. WebKit keeps the clock
moving; the spec says a suspended graph produces silence, so that is a song playing to nobody.
Either way the page believes it is playing while nothing is audible, and the player had no way
of noticing.

### 3. Starting the second deck without a tap (_from the code_)

At every track change the next deck was started with `audio.play()` from a timer
(`player.ts:343` and `:399`; `:625` for the clip path). Browsers only allow `play()` outside a tap
on an element they have already allowed. The player tried to unlock both elements by playing a
silent MP3 in the first tap (`:69`, `:198-203`), but after each fade it emptied the element with
`removeAttribute('src')` and `load()` (`:305-311`). Whether iOS keeps an element unlocked after
its source is reset is WebKit's own business. When `play()` was refused, the player set status
`error` (`:353`, `:404`) and the recovery (`recover()`, `:443`) tried the same `play()` again
without a tap.

### 4. Seeking and speed changes against plain MP3 files (_from the code_)

`resync()` ran every 2 s (`:419-441`). Drift above 60 ms was corrected by changing
`playbackRate` by up to ±4 %, and above 1 s by assigning `currentTime`. Each track also started
from a `#t=` media fragment, so the first request was a byte-range request into a 192 kbps CBR
MP3 (about 1.4 MB per minute, one fixed quality). On a weak cellular connection a seek means
waiting for a new range request, which shows as a stall; there was no lower bitrate to drop to.
The listener's playback position was also tied to a clock estimate (`clockSample`), so a bad
estimate meant repeated seeking.

### 5. A track change needed several things to go right at once (_from the code_)

For one hand-over the old player had to: receive the next-track message, download and decode
the transition clip with `decodeAudioData` (`:485-488`), measure where the playing deck sat inside
the clip by cross-correlation (`locate`, `:549`), splice, start the next deck early, measure it
again, and splice back. Each step had its own failure path that fell back to a plain crossfade,
and several fell back to `joinSlot`, a hard re-join with a fade. A track change was the most
fragile moment of the whole player, and it happened every few minutes on every phone.

### 6. Dead network connections were not rebuilt (_from the code_)

When Wi-Fi switched to cellular, requests made on the old connection never finished. The player
reacted to the `online` event only (`radio.tsx:158`), which does not fire for a Wi-Fi to cellular
hand-over. An element that simply stopped loading looked "buffering" forever.

## What replaced it, and how each cause is handled

| Cause                                        | Now                                                                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Timers decide the track change            | The engine changes tracks on the server. The page has no schedule to keep.                                                                                                                                                                     |
| 2. Web Audio graph can be suspended          | No Web Audio at all. One `<audio>` element plays the stream directly, so lock screen, AirPlay and the OS media controls treat it as ordinary media. `navigator.audioSession.type = 'playback'` is set where Safari supports it.                |
| 3. `play()` from a timer                     | `play()` is only called from the tap, or when rebuilding after a failure on an element that is already unlocked. A `NotAllowedError` stops the player cleanly and shows play again instead of looping.                                         |
| 4. Seeking, speed changes, one fixed bitrate | No seeking against a clock and no speed correction. Three bitrates (64k, 128k, 256k AAC) with automatic switching on hls.js; Safari switches natively.                                                                                         |
| 5. Fragile hand-over                         | The mix is rendered on the server. A track change is a join inside the stream.                                                                                                                                                                 |
| 6. Dead connections                          | `online`, the Network Information `change` event, `visibilitychange`, `pageshow` and `focus` all trigger recovery. A watchdog treats a "playing" element whose playhead stands still for 7 s as dead and rebuilds the connection with backoff. |

The player keeps one element and one player object for the life of the document
(`getAudioElement()`, `getStreamPlayer()` in `apps/web/lib/stream-player.ts`), so React
remounts (a language switch, say) cannot interrupt playback.

## How it was checked

`apps/web/scripts/stream-check.mjs` plays the live stream in emulated browsers and checks:
no autoplay before the tap, playback starts, the playhead keeps moving for 10 s, recovery after a
15 s frozen page (hls.js only), recovery after an 8 s network drop, the fall back to the MP3
stream when HLS is blocked, and no player errors in the console.

| Profile                      | Transport | Result                                                                  |
| ---------------------------- | --------- | ----------------------------------------------------------------------- |
| iPhone 15 (WebKit, emulated) | native    | all checks pass; the frozen-page check is skipped (see below)           |
| Pixel 7 (Chromium, emulated) | hls.js    | all checks pass; plays on for 10 s of a 15 s frozen page, then recovers |
| Desktop Chromium             | hls.js    | all checks pass; plays on for 6 s of a 15 s frozen page, then recovers  |

These run against the local stack, including through the machine's Wi-Fi address.

**What this does not prove**

- **No real phone was used.** Emulation does not suspend a page the way a locked iPhone does. The
  frozen-page check blocks the main thread, which is not the same thing as iOS suspending a
  page, so it is skipped for the native-HLS iPhone profile. Locking a real iPhone and listening
  through a track change is the test that is still owed.
- **Network drops are only partly emulated.** Playwright cuts requests the page itself makes,
  which is what hls.js does, so on Chromium these checks are real. Native HLS is loaded by the
  browser's media engine; whether Playwright's offline and request-blocking switches reach it in
  WebKit was not verified, so treat those two iPhone results as weaker evidence.
- **A live stream's runway is short.** Audio can only be buffered up to the live edge, so the
  distance behind live is how long a stall can last before the sound stops: about 6 s on
  desktop and 10 s on phones (`liveSyncDurationCount` 3 and 5 with 2-second segments). After a
  longer stall the player recovers by itself, jumping to the live point; the listener hears a gap
  but does not need to press play. More runway costs delay: each extra segment is 2 s later for
  everyone on that device.
