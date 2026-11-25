#!/bin/sh
# Copies Caddy's Let's Encrypt cert for Redis TLS and reloads it in place (Caddy renews every ~60 days).
set -e
SRC=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/130-61-178-247.sslip.io
install -o redis -g redis -m 640 "$SRC/130-61-178-247.sslip.io.crt" /etc/redis/tls/server.crt
install -o redis -g redis -m 640 "$SRC/130-61-178-247.sslip.io.key" /etc/redis/tls/server.key
if ss -ltn | grep -q ":6380 "; then
  PASS=$(sed -n "s/^requirepass //p" /etc/redis/radiot.conf)
  REDISCLI_AUTH="$PASS" timeout 10 redis-cli --tls --cacert /etc/ssl/certs/ca-certificates.crt --sni 130-61-178-247.sslip.io -h 127.0.0.1 -p 6380 CONFIG SET tls-cert-file /etc/redis/tls/server.crt >/dev/null
fi
