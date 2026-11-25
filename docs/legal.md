# Legal & compliance notes

> Engineering notes, not legal advice. Have a lawyer review before launch, especially music licensing.

## Music rights

- **Broadcasting recorded music publicly needs licences.** In Türkiye that typically means the collecting
  societies (e.g. MSG for authors/composers, MÜYAP/MÜ-YORBİR for producers/performers); in other markets,
  the local equivalents (PRS/PPL, ASCAP/BMI/SoundExchange, GEMA…). Budget for this before marketing.
- The **fallback playlist** must be fully licensed or royalty-free with a written licence on file.
- **User requests:** every submission requires an explicit rights confirmation. We store user id, IP hash,
  timestamp, SHA-256 and Chromaprint fingerprint (`requests` table) for accountability.
- **No platform ripping:** YouTube/Spotify/Apple Music resolvers are stubs; only direct audio files are
  accepted. Any future integration must use an officially licensed API.

## Takedowns (DMCA / 5651 notices)

1. Publish a contact address on the site (e.g. `abuse@radiot.app`).
2. On a valid notice, an admin uses **Admin → DMCA block** on the request: it is rejected and its
   fingerprint added to `dmca_blocklist`; future uploads matching it (similarity ≥ 0.8) are auto-rejected.
3. Every admin action is in the audit log. Repeat infringers: ban via Admin → Sanctions.

## Privacy (KVKK / GDPR)

- Data held: email, display name/handle, optional avatar, requests, votes, chat, reactions, push
  subscriptions, IP **hashes** (salted SHA-256, never raw IPs), Sentry/PostHog telemetry.
- Publish a privacy notice (Aydınlatma Metni) covering purposes, retention and rights; add a cookie notice
  if PostHog is enabled for EU/TR visitors.
- Provide account deletion: deleting a user cascades their requests, votes, chat and profile.

## Live camera

- Camera only; the microphone is blocked in three layers (client, LiveKit grant, server webhook).
- Performers must confirm they are **18+**. Streams can be reported; admins have a kill switch and bans.
- Do not record streams by default (no LiveKit egress configured).
