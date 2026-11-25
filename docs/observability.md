# Observability

## Signals

- **Errors:** Sentry in api (`SENTRY_DSN`) and worker (media job failures are captured with job data).
  The web app logs client errors through the error boundary; add `@sentry/nextjs` when traffic warrants it.
- **Logs:** pino JSON from api and worker (ship to Better Stack / Loki). Useful messages: `track started`,
  `round locked`, `media ready`, `tick failed`, `re-dispatched stuck request`, `api rejected worker event`.
- **Health:** `GET /health` (Postgres + Redis); `GET /api/now-playing` shows the timeline and `dueAt`.
- **Product:** PostHog events `listen_start`, `sign_in_requested`, `request_submitted`, `vote_cast`,
  `share_clicked`, `reaction_sent`, `go_live`.

## Error budgets (monthly, 99.5% unless noted)

| SLO                                                 | Target        | Measured by                           |
| --------------------------------------------------- | ------------- | ------------------------------------- |
| Timeline availability (`/api/now-playing` 200)      | 99.9%         | uptime check every 30 s               |
| Dead air (no track start for > track length + 60 s) | < 5 min/month | alert on missing `track started` logs |
| API availability                                    | 99.5%         | `/health` uptime check                |
| Media pipeline success (non-user-error)             | 99%           | worker `job failed` vs `media ready`  |
| Vote POST p95 latency                               | < 250 ms      | API request logs                      |

## Alerts

- Stream down 2 checks in a row → page. Dead air → page.
- `liquidsoap push failed` or `track notify failed (` > 3 in 10 min → Slack.
- Sentry: new issue in api/worker → Slack; error rate spike (> 20/min) → page.
- `mic_violations` row inserted → Slack (moderation), and admin dashboard shows it.
- Open reports > 10 or unreviewed vote flags > 20 → Slack (moderation backlog).

## PostHog dashboards

1. **Acquisition → activation funnel:** pageview → `listen_start` → `sign_in_requested` → `request_submitted` → `share_clicked`
   (breakdown by `utm_campaign`: `vote_for_me`, `song_won`, `embed`).
2. **Engagement:** DAU listening, median listen session, votes per round, reactions per minute.
3. **Retention:** weekly cohort retention on `listen_start`; requesters vs non-requesters.
4. **Stage:** `go_live` per day, share of request plays with a live performer.
