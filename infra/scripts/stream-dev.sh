#!/usr/bin/env bash
# Runs the whole stack locally for testing the live stream, reachable from a phone on the same
# Wi-Fi: worker (4100), api (4000), engine (4200, with Liquidsoap + Icecast) and web (3000).
#
#   infra/scripts/stream-dev.sh start    # prints the URL to open on the phone
#   infra/scripts/stream-dev.sh status
#   infra/scripts/stream-dev.sh stop
#
# Environment (all optional):
#   STREAM_DB     Postgres URL to use instead of apps/api/.env (e.g. the lab database)
#   STREAM_REDIS  Redis URL (default redis://localhost:6379/5, a separate database index)
#   LOCAL_MEDIA   folder served as the media store (default .tmp/stream/media)
#   LAN_IP        address to advertise (default: en0)
#   WEB=0         do not start the web app
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
RUN="$ROOT/.tmp/stream"
mkdir -p "$RUN"
IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
DB="${STREAM_DB:-}"
REDIS="${STREAM_REDIS:-redis://localhost:6379/5}"
MEDIA="${LOCAL_MEDIA:-$RUN/media}"
SECRET="dev-internal-secret-change-me"

pidfile="$RUN/pids"

stop() {
  if [ -f "$pidfile" ]; then
    while read -r pid name; do
      kill "$pid" 2>/dev/null && echo "stopped $name ($pid)" || true
    done <"$pidfile"
    rm -f "$pidfile"
  fi
  # tsx/next spawn children; make sure the ports are free and the helpers are gone
  for port in 3000 4000 4100 4200; do
    lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
  done
  pkill -f "liquidsoap/radiot.liq" 2>/dev/null || true
  pkill -f "icecast -c $ROOT" 2>/dev/null || true
}

start_one() { # name dir env... -- command...
  local name=$1 dir=$2
  shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  (cd "$dir" && env "${envs[@]}" "$@" >"$RUN/$name.log" 2>&1 &
    echo "$! $name" >>"$pidfile")
}

wait_http() { # url seconds
  for _ in $(seq 1 "$2"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1 (see $RUN/*.log)" >&2
  return 1
}

case "${1:-start}" in
stop)
  stop
  ;;
status)
  for p in 3000:web 4000:api 4100:worker 4200:engine; do
    curl -sf -o /dev/null -m 2 "http://127.0.0.1:${p%%:*}/" && echo "up   ${p##*:}" || echo "down ${p##*:}"
  done
  ;;
start)
  stop
  : >"$pidfile"
  DBENV=()
  [ -n "$DB" ] && DBENV=("DATABASE_URL=$DB")
  start_one worker apps/worker "${DBENV[@]}" PORT=4100 "LOCAL_MEDIA_DIR=$MEDIA" \
    "MEDIA_BASE_URL=http://$IP:4100/media" API_URL=http://localhost:4000 "INTERNAL_SECRET=$SECRET" \
    -- npx tsx --env-file-if-exists=.env src/index.ts
  start_one api apps/api "${DBENV[@]}" "REDIS_URL=$REDIS" PORT=4000 WORKER_URL=http://localhost:4100 \
    "MEDIA_BASE_URL=http://$IP:4100/media" WEB_ORIGIN=http://localhost:3000 \
    "EXTRA_WEB_ORIGINS=http://$IP:3000" "INTERNAL_SECRET=$SECRET" \
    -- npx tsx --env-file-if-exists=.env src/index.ts
  wait_http http://127.0.0.1:4000/health 40 || wait_http http://127.0.0.1:4000/api/now-playing 40
  start_one engine apps/engine API_URL=http://localhost:4000 PORT=4200 HOST=0.0.0.0 \
    "RUN_DIR=$RUN/engine" "PUBLIC_URL=" \
    -- npx tsx --env-file-if-exists=.env src/index.ts
  if [ "${WEB:-1}" != "0" ]; then
    start_one web apps/web "NEXT_PUBLIC_SITE_URL=http://$IP:3000" "NEXT_PUBLIC_API_URL=http://$IP:3000" \
      API_PROXY_TARGET=http://localhost:4000 "NEXT_PUBLIC_SOCKET_URL=http://$IP:4000" \
      "NEXT_PUBLIC_ENGINE_URL=http://$IP:4200" \
      -- npx next dev -H 0.0.0.0 -p 3000
  fi
  wait_http http://127.0.0.1:4200/health 90
  echo
  echo "engine   http://$IP:4200/health   (stream: http://$IP:4200/hls/radiot.m3u8)"
  [ "${WEB:-1}" != "0" ] && echo "website  http://$IP:3000   <- open this on the phone (same Wi-Fi)"
  echo "logs     $RUN/*.log"
  ;;
*)
  echo "usage: $0 start|stop|status" >&2
  exit 1
  ;;
esac
