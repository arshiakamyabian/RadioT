"""Checks that Liquidsoap joins track | transition clip | track exactly where the plan says.

Builds the three pieces the way the engine does (sample-exact cuts of the cached tracks, the clip
whole), plays them through Liquidsoap into a WAV, builds the same audio offline with numpy, and
reports how far each section sits from where it should (in samples) and the largest error.

  apps/worker/ml/.venv/bin/python apps/engine/scripts/splice-check.py <transition-id>

Needs: ffmpeg, liquidsoap, psql, the DB in DATABASE_URL (default: the local lab database) and
LOCAL_MEDIA (default .tmp/lab/media) holding cooked/ and transitions/ files.
"""

import os
import socket
import subprocess
import sys
import tempfile
import time

import numpy as np
import soundfile as sf

DB = os.environ.get("DATABASE_URL", "postgres://radiot:radiot@localhost:5432/radiot_lab")
MEDIA = os.path.expanduser(os.environ.get("LOCAL_MEDIA", "~/code/radiot/.tmp/lab/media"))
SR = 44_100
LEAD = 5000  # ms of each track played around the clip


def sql(q: str) -> str:
    return subprocess.check_output(["psql", DB, "-At", "-F", "|", "-c", q]).decode().strip()


def main(tid: str) -> int:
    row = sql(
        "select t.from_id, t.to_id, t.clip_key, t.clip->>'aFileStartMs', t.clip->>'handoffFileMs',"
        " coalesce(a.gain_db,0), coalesce(b.gain_db,0), a.storage_key, b.storage_key"
        f" from transitions t join (select id, gain_db, storage_key from fallback_tracks union all"
        " select id, gain_db, storage_key from requests) a on a.id=t.from_id"
        " join (select id, gain_db, storage_key from fallback_tracks union all"
        " select id, gain_db, storage_key from requests) b on b.id=t.to_id"
        f" where t.id='{tid}' and t.status='ready'"
    )
    if not row:
        print("no ready transition with that id")
        return 2
    _, _, clip_key, a_file, handoff, ga, gb, a_key, b_key = row.split("|")
    a_file, handoff, ga, gb = float(a_file), float(handoff), float(ga), float(gb)
    work = tempfile.mkdtemp(prefix="splice-")

    def flac(src: str, name: str) -> str:
        dst = f"{work}/{name}.flac"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", f"{MEDIA}/{src}",
                        "-ar", str(SR), "-ac", "2", "-c:a", "flac", dst], check=True)
        return dst

    srcs = {"a": flac(a_key, "a"), "b": flac(b_key, "b"), "clip": flac(clip_key, "clip")}
    pieces = [
        ("a", a_file - LEAD, a_file, ga),
        ("clip", 0.0, None, 0.0),
        ("b", handoff, handoff + LEAD, gb),
    ]
    files = []
    for i, (name, start, end, _) in enumerate(pieces):
        if name == "clip":
            files.append(srcs["clip"])
            continue
        out = f"{work}/piece{i}.wav"
        trim = f"atrim=start_sample={round(start / 1000 * SR)}:end_sample={round(end / 1000 * SR)},asetpts=N/SR/TB"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", srcs[name], "-af", trim,
                        "-c:a", "pcm_s16le", "-f", "wav", out], check=True)
        files.append(out)

    port = 1239
    with open(f"{work}/t.liq", "w") as f:
        f.write(f'settings.server.telnet := true\nsettings.server.telnet.port := {port}\n'
                'q = request.queue(id="radio")\ns = mksafe(amplify(1.0, override="liq_amplify", q))\n'
                f'output.file(%wav, "{work}/out.wav", fallible=false, s)\n')
    proc = subprocess.Popen(["liquidsoap", f"{work}/t.liq"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
                break
            except OSError:
                time.sleep(0.5)
        conn = socket.create_connection(("127.0.0.1", port))
        for (name, _, _, gain), path in zip(pieces, files):
            conn.sendall(f'radio.push annotate:liq_amplify="{gain:.2f} dB":{path}\n'.encode())
            time.sleep(0.2)
        time.sleep(2 * LEAD / 1000 + sf.info(srcs["clip"]).duration + 2)
        conn.sendall(b"quit\n")
    finally:
        time.sleep(0.3)
        proc.terminate()
        proc.wait()

    out, _ = sf.read(f"{work}/out.wav", dtype="float32")

    def part(name: str, start: float, end, gain: float):
        x, _ = sf.read(srcs[name], dtype="float32")
        i0 = round(start / 1000 * SR)
        i1 = len(x) if end is None else round(end / 1000 * SR)
        return x[i0:i1] * np.float32(10 ** (round(gain, 2) / 20))

    parts = [part(*p) for p in pieces]
    ref = np.concatenate(parts)
    probe = ref[SR:2 * SR, 0]
    n = 1 << (len(out) + len(probe)).bit_length()
    cc = np.fft.irfft(np.fft.rfft(out[:, 0], n) * np.conj(np.fft.rfft(probe, n)), n)[: len(out)]
    start = int(np.argmax(cc)) - SR
    seg = out[start:start + len(ref)]
    bounds = np.cumsum([0] + [len(p) for p in parts])
    worst = 0
    print(f"transition {tid[:8]}: {len(ref) / SR:.2f} s compared")
    for k, (name, *_rest) in enumerate(pieces):
        lo = int(bounds[k]) + 20_000
        hi = min(lo + SR, int(bounds[k + 1]) - 100, len(seg) - 4000)
        probe = ref[lo:hi, 0]
        shift = max(range(-3000, 3001), key=lambda d: float(np.dot(seg[lo + d:hi + d, 0], probe))
                    if lo + d >= 0 and hi + d <= len(seg) else -1e9)
        err = float(np.abs(seg[int(bounds[k]) + 200:int(bounds[k + 1]) - 200] -
                           ref[int(bounds[k]) + 200:int(bounds[k + 1]) - 200]).max())
        print(f"  {name:5s} sits {shift:+d} samples from the plan, max error {err:.1e}")
        worst = max(worst, abs(shift))
    print("PASS: every join is sample-exact" if worst == 0 else f"FAIL: off by up to {worst} samples")
    return 0 if worst == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]) if len(sys.argv) > 1 else print(__doc__) or 2)
