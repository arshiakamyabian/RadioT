import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const HTTP_API = __ENV.API || 'http://localhost:4000';
const API = HTTP_API.replace(/^http/, 'ws');
const connectTime = new Trend('socketio_connect_ms', true);

export const options = {
  scenarios: {
    listeners: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 1000 },
        { duration: '3m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{kind:timeline}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    socketio_connect_ms: ['p(95)<1000'],
  },
};

// Each VU behaves like a listener: one Socket.IO connection (engine.io v4 over websocket) that
// joins the listeners room, while polling the station timeline the way the web player does.
// Audio itself comes from Vercel Blob's CDN, so it is not part of this test.
export default function () {
  const started = Date.now();
  ws.connect(`${API}/socket.io/?EIO=4&transport=websocket`, {}, (socket) => {
    socket.on('message', (msg) => {
      if (msg.startsWith('0'))
        socket.send('40'); // engine.io open → socket.io connect
      else if (msg.startsWith('40')) {
        connectTime.add(Date.now() - started);
        socket.send('42["radio:listen",true]');
      } else if (msg === '2') socket.send('3'); // ping → pong
    });
    socket.setInterval(() => {
      const res = http.get(`${HTTP_API}/api/now-playing`, { tags: { kind: 'timeline' } });
      check(res, { 'timeline 200': (r) => r.status === 200 });
    }, 20000);
    socket.setTimeout(() => socket.close(), 60000);
  });
  sleep(1);
}
