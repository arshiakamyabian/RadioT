# Oracle stream server

Always Free A1 VM (4 OCPU / 24 GB, Ubuntu 24.04 arm64) running the stream engine
(Liquidsoap + Icecast + Node, `apps/engine`) and the media/AI worker (`apps/worker`).
The website reaches it through its own `/stream/*` rewrite, so networks that block the
VM's host name still play the radio.

## Rebuild from scratch

1. Create the instance with `cloud-init.yaml` (opens 80/443, SSH on 22 and 443).
2. Install: `nodejs` 22, `pnpm`, `ffmpeg`, `liquidsoap` 2.4, `icecast2`, `caddy`, `sslh`.
3. Copy the repo to `/opt/radiot`, `pnpm install`, `pnpm turbo run build --filter=@radiot/engine... --filter=@radiot/worker...`.
4. Write `apps/engine/.env` and `apps/worker/.env` (+ `.env.blob`) from the `.env.example` files.
5. AI models: `apps/worker/ml` venv (see its README); `ML_DEVICE=cpu`, `ML_STEM_MODEL=htdemucs`.
6. Install the files here:

   | file                                                                                                 | goes to                                                     |
   | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
   | `radiot-engine.service`, `radiot-worker.service`, `radiot-watchdog.service`, `radiot-watchdog.timer` | `/etc/systemd/system/`                                      |
   | `engine-priority.conf`                                                                               | `/etc/systemd/system/radiot-engine.service.d/priority.conf` |
   | `worker-priority.conf`                                                                               | `/etc/systemd/system/radiot-worker.service.d/priority.conf` |
   | `restart-always.conf`                                                                                | `/etc/systemd/system/{caddy,sslh}.service.d/`               |
   | `radiot-watchdog.sh`                                                                                 | `/usr/local/bin/radiot-watchdog` (mode 755)                 |
   | `Caddyfile`                                                                                          | `/etc/caddy/Caddyfile`                                      |
   | `sslh.default`                                                                                       | `/etc/default/sslh`                                         |

7. `systemctl daemon-reload && systemctl enable --now radiot-engine radiot-worker radiot-watchdog.timer caddy sslh`.

## Redis (since 2026-11-23)

The Vercel API's Redis runs here; Upstash's free 500k-commands/month quota ran out and took the
site down. Redis listens only on TLS port 6380 (password required), using Caddy's Let's Encrypt
certificate. Oracle can't route the VM's public IP back to itself, so test it from the VM with
`redis-cli --tls --cacert /etc/ssl/certs/ca-certificates.crt --sni 130-61-178-247.sslip.io -h 127.0.0.1 -p 6380`.

1. `apt install redis-server`; `redis-radiot.conf` → `/etc/redis/radiot.conf` (owner `redis`, mode 640,
   real password from `openssl rand -hex 32`), then append `include /etc/redis/radiot.conf` to `/etc/redis/redis.conf`.
2. `radiot-redis-certs.sh` → `/usr/local/bin/radiot-redis-certs` (755); `radiot-redis-certs.{service,timer}` →
   `/etc/systemd/system/`; `systemctl enable --now radiot-redis-certs.timer` (copies a renewed cert daily).
3. Open port 6380 in iptables (`iptables -I INPUT 5 -p tcp --dport 6380 -j ACCEPT && netfilter-persistent save`)
   and in the VCN's default security list.
4. radiot-api `REDIS_URL` = `rediss://default:<password>@130-61-178-247.sslip.io:6380`.

## Self-healing

- Every service restarts on crash (`Restart=always`) and on boot.
- `radiot-watchdog` (every minute) restarts the engine when no HLS segment was written for
  20 s or the program is more than 30 s off the timeline, and restarts Caddy/sslh when the
  public HTTPS path stops answering; two failed checks in a row are needed. Log:
  `journalctl -u radiot-watchdog`.
- The engine itself rejoins the timeline when a piece goes on air more than 6 s off
  (`lagMs` in `/health`).
- Liquidsoap runs at a higher priority than the AI analysis, so analysis never starves the stream.
