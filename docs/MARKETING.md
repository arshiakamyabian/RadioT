# RadioT — Marketing Plan

> Goal for the first 90 days: prove the core loop — **listen → request → share → friends vote → song plays live** — with a
> Turkish-first community, then expand. Every tactic below maps to an event we already track in PostHog.

## 1. Positioning

**One-liner (EN):** "The radio where the listeners are the DJ. Request a song, get your friends to vote, hear it live — and go on
camera while it plays."
**TR:** "DJ'i dinleyicilerin olduğu radyo. Şarkını iste, arkadaşların oylasın, canlı yayında çalsın — çalarken kamerayla sahneye çık."

**Why it spreads:** the product has a built-in share moment. A request only wins if people vote, so every requester is
motivated to send a "vote for me" link (`utm_campaign=vote_for_me`). A win produces a second moment ("my song is playing
now", `song_won` OG card) and the camera turns it into something worth screen-recording.

**Audience, in order:**

1. Turkish 16–30 year-olds who already share music in group chats (WhatsApp, Instagram DMs, Discord).
2. Bedroom producers and independent artists who want an audience for their own tracks (they own the rights — ideal
   for our rights model).
3. Online communities that want a shared soundtrack (Discord servers, university clubs, streamer communities).

**What we never do:** pay for votes, sell vote boosts, or ship anything that makes voting feel bought. Monetization stays
cosmetic (handle badges, profile themes). This is a trust asset — say it out loud in marketing.

## 2. Pre-launch (weeks −4 to 0)

- **Licensing first.** Do not market until the fallback library is licensed and the collecting-society position is
  clear (see `docs/legal.md`). A takedown during launch week would be fatal.
- **Seed library:** 300+ licensed/royalty-free tracks for the fallback rotation, curated into a clear identity
  (e.g. Turkish indie, Anatolian rock re-edits from licensed catalogs, lo-fi), so first visitors hear something good.
- **Founding artists:** recruit 30–50 independent Turkish artists/producers (SoundCloud, Bandcamp, Instagram,
  university music clubs) to pre-upload their own tracks. Give them a "Founding Artist" badge (cosmetic).
- **Waitlist + Discord:** one landing CTA ("get notified when we go live") and a RadioT Discord with channels for
  requests, feedback and #now-playing (bot posting `radio:now`).
- **Content bank:** record 20 short clips during the beta (song wins, live camera reactions, vote countdown
  finishes) for launch-week posting.

## 3. Channels

### TikTok / Instagram Reels / YouTube Shorts (primary)

- **Formats that fit the product:**
  - "My song won the vote" — screen recording of the countdown hitting zero and the track starting.
  - "Going live while my song plays on a radio" — the camera feature is the hook.
  - "Rating the songs people requested today" — daily host-style recap from the weekly chart.
  - Artist POV: "I uploaded my own track to a live radio and strangers voted for it."
- Post 1–2 per day in launch month; keep each clip under 20 s with the RadioT handle burned in. Turkish captions first,
  English variants for the second wave.
- Every bio link points to `/?utm_source=tiktok|instagram|youtube&utm_medium=social`.

### Discord

- Our own server (community + feedback), plus partnerships with existing Turkish music/gaming servers: offer a
  `/radiot` embed (`/embed` iframe player) and a "server night" where a server's members take over requests for an hour.
- KPI: listeners arriving with `utm_source=discord` and their request rate.

### Reddit and forums

- r/Turkey, r/KGBTR-style communities, r/WeAreTheMusicMakers, r/IndieMusicFeedback, r/listentothis (follow each
  sub's self-promotion rules; participate before posting). Ekşi Sözlük and Donanımhaber for organic discussion — do
  not astroturf; let real users post.
- Best post: an honest "I built a radio where listeners vote on every song; here's what the first week of requests
  looked like" with the weekly chart.

### Twitch / YouTube live

- Approach small and mid-size Turkish music, just-chatting and chill streamers to run RadioT as background music,
  letting their chat request and vote. The streamer gets a cosmetic profile badge and a featured slot on the home page.
- Streams are a top-of-funnel source; measure via `utm_source=twitch` on the panel link.

### DJs, artists and creators

- **Guest hours:** a DJ or artist "hosts" an hour — they go live on camera whenever their requests win, and promote
  it to their audience beforehand.
- **Artist premieres:** independent artists premiere a track on RadioT; their fans must vote it in. Natural
  motivation to share.
- **Micro-creators over celebrities:** 20 creators with 5–50k followers beat one big name for authenticity and cost.
  Pay a flat fee per post; never pay for votes or ask creators to buy engagement.

### SEO (compounding, long term)

- **Pages already built for search:** `/history/[id]` (every played song, MusicRecording JSON-LD), `/u/[handle]`
  (ProfilePage), `/charts` (MusicPlaylist), all in EN + TR with hreflang.
- **Content plan:** a weekly "RadioT Top 20" chart page with short commentary (TR + EN), an "independent Turkish
  artists to watch" monthly roundup built from chart data, and evergreen guides ("how to get your song on the radio",
  "royalty-free Turkish music for streams").
- **Technical:** keep the sitemap fresh (hourly revalidate), aim for Lighthouse ≥ 95 mobile, earn links from artist
  pages (artists link to their own RadioT history pages when they win).

## 4. Launch timeline (30 / 60 / 90 days)

**Days 1–30 — Launch in Türkiye**

- Launch week: daily short-form clips, Discord launch event, founding artists post their "vote for me" links on day 1.
- Run 3 guest DJ hours and 2 artist premieres.
- Two Reddit/forum launch posts (one TR, one EN builders' story).
- Fix the top 10 friction points seen in PostHog funnels and session feedback.

**Days 31–60 — Habit and community**

- Weekly ritual: Friday "chart reveal" stream + clip. Monthly "server takeover" with partner Discord servers.
- Turn on web push for won/live/expired notifications for all opted-in users; measure return visits.
- Recruit 10 Twitch/YouTube streamers for background use.
- First SEO content pieces published; submit sitemap in Search Console (TR + EN properties).

**Days 61–90 — Expand**

- English-language push (r/listentothis, international indie artist communities, English clips).
- Embed partnerships: blogs, artist sites and Discord servers embedding `/embed`.
- Evaluate a second station/genre channel only if retention targets are met.

## 5. KPIs (PostHog)

| Stage         | Event / metric                                    | Day-30 target | Day-90 target |
| ------------- | ------------------------------------------------- | ------------- | ------------- |
| Reach         | Unique visitors                                   | 10k           | 50k           |
| Activation    | `listen_start` / visitors                         | 45%           | 50%           |
| Sign-up       | `sign_in_requested` / listeners                   | 12%           | 15%           |
| Core action   | `request_submitted` per week                      | 500           | 3,000         |
| Virality      | `share_clicked` per request                       | 1.5           | 2.0           |
| Viral sources | Share in visitors from `utm_campaign=vote_for_me` | 15%           | 25%           |
| Engagement    | `vote_cast` per round (median)                    | 10            | 50            |
| Stage         | Share of request plays with `go_live`             | 10%           | 20%           |
| Retention     | Week-1 retention (`listen_start`)                 | 20%           | 30%           |
| Concurrency   | Peak concurrent listeners                         | 300           | 1,500         |

Review weekly using the funnels in `docs/observability.md`. If activation is weak, fix the first 10 seconds (autoplay
affordance, now-playing clarity). If sign-up is weak, test "vote without account first, sign in to confirm". If
virality is weak, improve the share card and the moment we prompt for it (right after a request becomes ready).

## 6. Budget (lean, first 90 days)

| Item                                                                         | Estimate                           |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| Music licensing (collecting societies, fallback library)                     | get quotes — the biggest line item |
| Micro-creator posts (20 × flat fee)                                          | €2–4k                              |
| Guest DJ / artist hour fees                                                  | €1–2k                              |
| Infra (VPS, Cloudflare, LiveKit Cloud, S3, email, PostHog/Sentry free tiers) | €150–400 / month                   |
| Merch / prizes for chart winners (cosmetic, not vote-linked)                 | €500                               |

## 7. Risks

- **Rights takedowns** → licensing before launch, fingerprint blocklist, fast takedown handling.
- **Inappropriate camera streams** → 18+ gate, reports, admin kill switch, moderation coverage during peaks.
- **Vote manipulation** → one vote per account per round, Turnstile, multi-account flags reviewed daily; never sell votes.
- **Empty-room problem at launch** → founding artists, guest hours at fixed times, and a great fallback rotation so the
  station sounds good even with nobody requesting.
