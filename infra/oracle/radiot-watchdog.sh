#!/usr/bin/env bash
# Runs every minute (radiot-watchdog.timer). Repairs what systemd can't see: a stream that is
# "running" but silent, stuck or drifting, and a public HTTPS path that stopped answering.
set -u
STATE=/var/lib/radiot/watchdog
mkdir -p "$STATE"
HLS_DIR=$(grep -E '^HLS_DIR=' /opt/radiot/apps/engine/.env | cut -d= -f2)
HLS_DIR=${HLS_DIR:-/var/lib/radiot/run/hls}
PUBLIC_HOST=$(grep -E '^PUBLIC_URL=' /opt/radiot/apps/engine/.env | sed -E 's#.*https?://([^/]+).*#\1#')
log() { echo "watchdog: $*"; }

strike() { # name -> number of consecutive failures
  local f="$STATE/$1" n=0
  [ -f "$f" ] && n=$(cat "$f")
  n=$((n + 1)); echo $n > "$f"; echo $n
}
clear_strikes() { rm -f "$STATE/$1"; }

# 1. Engine: answers, polls the API, plays on schedule, keeps writing HLS segments.
problem=""
health=$(curl -s -m 5 http://127.0.0.1:4200/health || true)
if [ -z "$health" ]; then
  problem="engine not answering"
else
  lag=$(echo "$health" | python3 -c 'import json,sys; print(abs(json.load(sys.stdin).get("lagMs") or 0))' 2>/dev/null || echo 0)
  [ "${lag:-0}" -gt 30000 ] && problem="program ${lag} ms off the timeline"
fi
newest=$(find "$HLS_DIR" -name '*.ts' -newermt '-20 seconds' 2>/dev/null | head -1)
[ -z "$newest" ] && problem="${problem:+$problem; }no new HLS segment for 20 s"
if [ -n "$problem" ]; then
  n=$(strike engine)
  log "engine problem ($n): $problem"
  if [ "$n" -ge 2 ]; then log "restarting radiot-engine"; systemctl restart radiot-engine; clear_strikes engine; fi
else
  clear_strikes engine
fi

# 2. Public path: sslh on 443 -> Caddy -> engine, with a valid certificate.
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/now" || true)
if [ "$code" != "200" ]; then
  n=$(strike public)
  log "public https answered '$code' ($n)"
  if [ "$n" -ge 2 ]; then log "restarting caddy and sslh"; systemctl restart caddy sslh; clear_strikes public; fi
else
  clear_strikes public
fi

# 3. API timeline (on Vercel): only logged, the engine keeps playing what it has.
poll=$(echo "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("lastPollAgoMs") or 0)' 2>/dev/null || echo 0)
[ "${poll:-0}" -gt 120000 ] && log "API unreachable for ${poll} ms"
exit 0
