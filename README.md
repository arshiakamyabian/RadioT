# RadioT

A 24/7 live community web radio. Everyone hears the same song at the same moment; listeners request songs (upload or
direct audio link), vote on what plays next, and the person whose song is on air can go live on camera
(video only — the mic is impossible by design). Professional, precomputed crossfades between every track.

Docs: [`CLAUDE.md`](./CLAUDE.md) (handbook) · [`docs/architecture.md`](./docs/architecture.md) ·
[`docs/plan.md`](./docs/plan.md) · [`docs/deploy.md`](./docs/deploy.md) · [`docs/observability.md`](./docs/observability.md) ·
[`docs/MARKETING.md`](./docs/MARKETING.md) · [`docs/progress.md`](./docs/progress.md)

## Run locally

No Docker. Requirements: Node ≥ 22 (CI uses 24), pnpm 10, ffmpeg + chromaprint
(`brew install ffmpeg chromaprint`), and the hosted dev services from the Vercel Marketplace:
a **Neon** Postgres, an **Upstash** Redis and a **Vercel Blob** store (free tiers are enough).
A local Postgres/Redis (e.g. via Homebrew) also works; Blob is always the hosted one.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env          # DATABASE_URL, REDIS_URL, BLOB_READ_WRITE_TOKEN,
cp apps/worker/.env.example apps/worker/.env    #   BETTER_AUTH_SECRET (openssl rand -base64 32)
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate && pnpm db:seed
pnpm dev                                         # web :3000, api :4000, worker :4100
pnpm fallback:demo && pnpm fallback:import       # synthesize + ingest royalty-free demo tracks
```

Tip: once the Vercel projects exist, `vercel env pull` in `apps/api` fills in the storage variables.

Open http://localhost:3000 and press play. Sign-in magic links are printed in the API log unless
`SMTP_URL` is set. Make yourself admin with `pnpm admin:grant you@example.com`. Live video needs a
LiveKit Cloud project (`LIVEKIT_*` in `apps/api/.env`, `NEXT_PUBLIC_LIVEKIT_URL` in the web env).

| Service    | URL                                   |
| ---------- | ------------------------------------- |
| Web        | http://localhost:3000                 |
| API health | http://localhost:4000/health          |
| Timeline   | http://localhost:4000/api/now-playing |

Deploying: see [`docs/deploy.md`](./docs/deploy.md) (three Vercel projects: web, api, worker).

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit/integration
pnpm test:e2e                              # Playwright; full-stack specs need pnpm dev + dev services
k6 run infra/load/listeners.js             # load test (see infra/load/README.md)
```
