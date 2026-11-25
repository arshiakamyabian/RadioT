# Load tests (k6)

Install k6 (`brew install k6`), start the stack, then:

```bash
# 1,000 concurrent listeners: timeline polling + a Socket.IO connection each
k6 run -e API=http://localhost:4000 infra/load/listeners.js

# Vote storm: many signed-in users voting/changing votes in one round
# Create sessions first (see seed-voters.sh), then:
k6 run -e API=http://localhost:4000 -e COOKIES_FILE=voters.txt infra/load/vote-storm.js
```

Targets: p95 `/api/now-playing` < 300 ms (audio is served by Vercel Blob's CDN),
Socket.IO connect p95 < 1 s, vote POST p95 < 250 ms with 0 errors other than expected 409/429.
Tune: Socket.IO rooms (only `listeners` gets counts), the `radio:due` cache in the station tick,
and the `votes_round_request_idx` / `requests_status_idx` indexes.
