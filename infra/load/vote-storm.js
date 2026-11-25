import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const API = __ENV.API || 'http://localhost:4000';
// One Better Auth session cookie per line (better-auth.session_token=...).
const cookies = new SharedArray('cookies', () =>
  open(__ENV.COOKIES_FILE || 'voters.txt')
    .split('\n')
    .filter(Boolean),
);

export const options = {
  scenarios: {
    storm: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: { 'http_req_duration{kind:vote}': ['p(95)<250'], checks: ['rate>0.99'] },
};

export default function () {
  const cookie = cookies[Math.floor(Math.random() * cookies.length)];
  const round = http.get(`${API}/api/rounds/current`, { headers: { cookie } }).json('round');
  const candidates = (round && round.candidates) || [];
  if (!candidates.length) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)].id;
  const res = http.post(`${API}/api/rounds/current/vote`, JSON.stringify({ requestId: pick }), {
    headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost:3000' },
    tags: { kind: 'vote' },
  });
  // 409 = round locked, 429 = per-user limiter: both are correct behaviour under a storm.
  check(res, { 'vote accepted or correctly refused': (r) => [200, 409, 429].includes(r.status) });
}
