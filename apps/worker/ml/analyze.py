"""RadioT music analysis with pretrained models.

For one audio file (the cooked MP3, so every time refers to what listeners hear) this computes:

- stems with Demucs (htdemucs_ft: drums, bass, other, vocals), written as 16-bit FLAC;
- beats and downbeats with Beat This! (madmom's RNN + DBN as fallback);
- song structure (intro / verse / chorus / bridge / outro ...) with All-In-One, fed the stems
  above (All-In-One's NATTEN dependency is replaced by shims/natten, see test_natten_shim.py);
- loudness curves of each stem, for the transition planner's stem-aware mixing.

Usage:
  .venv/bin/python analyze.py <audio> --out result.json --stems-dir stems/
  .venv/bin/python analyze.py --batch <dir-of-mp3> --out-dir <dir>   (one song at a time)

The JSON matches `aiAnalysisSchema` in packages/shared/src/ai.ts.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
# All-In-One's checkpoints store their config next to the weights.
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
sys.path.insert(0, str(Path(__file__).parent / "shims"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

SR = 44_100
STEMS = ("drums", "bass", "other", "vocals")
CURVE_STEP_MS = 100
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def decode(path: Path) -> np.ndarray:
    """Stereo float32 (2, n) at 44.1 kHz, decoded by ffmpeg exactly like the worker does."""
    raw = subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-vn",
         "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def pick_device(name: str) -> str:
    if name != "auto":
        return name
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# ---- stems ------------------------------------------------------------------------------------

def separate(wav: np.ndarray, model_name: str, device: str, shifts: int) -> dict[str, np.ndarray]:
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model(model_name)
    model.eval()
    mix = torch.from_numpy(wav)
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((mix - mean) / std)[None], device=device, shifts=shifts,
                          split=True, overlap=0.25, progress=False)[0]
    out = out * std + mean
    stems = {name: out[i].numpy() for i, name in enumerate(model.sources)}
    del model, out
    gc.collect()
    return stems


def stem_curves(stems: dict[str, np.ndarray]) -> dict[str, list[int]]:
    """RMS level of each stem every 100 ms over a 400 ms window, in 0.1 dBFS (floor -90 dB)."""
    hop = SR * CURVE_STEP_MS // 1000
    win = hop * 4
    curves: dict[str, list[int]] = {}
    for name, x in stems.items():
        mono = x.mean(0).astype(np.float64)
        sq = np.concatenate([[0.0], np.cumsum(mono * mono)])
        n = len(mono)
        frames = (n + hop - 1) // hop
        vals = []
        for f in range(frames):
            c = f * hop
            a, b = max(0, c - win // 2), min(n, c + win // 2)
            e = (sq[b] - sq[a]) / max(1, b - a)
            vals.append(int(round(max(-90.0, 10 * np.log10(e + 1e-12)) * 10)))
        curves[name] = vals
    return curves


# ---- beats ------------------------------------------------------------------------------------

def beats_beat_this(wav: np.ndarray, device: str) -> tuple[list[float], list[float], str]:
    from beat_this.inference import Audio2Beats

    tracker = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    beats, downbeats = tracker(wav.T, SR)
    del tracker
    return [float(b) for b in beats], [float(d) for d in downbeats], "beat_this:final0"


def beats_madmom(wav: np.ndarray) -> tuple[list[float], list[float], str]:
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor
    from madmom.audio.signal import Signal

    sig = Signal(wav.mean(0), sample_rate=SR, num_channels=1)
    act = RNNDownBeatProcessor()(sig)
    out = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)(act)
    beats = [float(t) for t, _ in out]
    downs = [float(t) for t, pos in out if int(pos) == 1]
    return beats, downs, "madmom:RNNDownBeat+DBN"


# ---- structure --------------------------------------------------------------------------------

def structure_allin1(stems: dict[str, np.ndarray], device: str) -> tuple[list[dict], list[float], str]:
    from madmom.audio.signal import FramedSignalProcessor, Signal
    from madmom.audio.spectrogram import (FilteredSpectrogramProcessor,
                                          LogarithmicSpectrogramProcessor)
    from madmom.audio.stft import ShortTimeFourierTransformProcessor
    from madmom.processors import SequentialProcessor

    from allin1.models import load_pretrained_model
    from allin1.postprocessing import (postprocess_functional_structure,
                                       postprocess_metrical_structure)

    processor = SequentialProcessor([
        FramedSignalProcessor(frame_size=2048, fps=100),
        ShortTimeFourierTransformProcessor(),
        FilteredSpectrogramProcessor(num_bands=12, fmin=30, fmax=17000, norm_filters=True),
        LogarithmicSpectrogramProcessor(mul=1, add=1),
    ])
    spec = np.stack([
        processor(Signal(stems[name].mean(0), sample_rate=SR, num_channels=1))
        for name in ("bass", "drums", "other", "vocals")
    ])
    model = load_pretrained_model(model_name="harmonix-all", device=device)
    with torch.no_grad():
        logits = model(torch.from_numpy(spec).unsqueeze(0).to(device))
        segments = postprocess_functional_structure(logits, model.cfg)
        metrical = postprocess_metrical_structure(logits, model.cfg)
    del model, logits
    gc.collect()
    segs = [{"start": float(s.start), "end": float(s.end), "label": str(s.label)} for s in segments]
    return segs, [float(d) for d in metrical["downbeats"]], "allin1:harmonix-all"


# ---- main -------------------------------------------------------------------------------------

def analyze(path: Path, out: Path, stems_dir: Path, device: str, stem_model: str, shifts: int,
            keep_wav: bool = False, head_sec: float = 0, tail_sec: float = 0) -> dict:
    t0 = time.time()
    wav = decode(path)
    n = wav.shape[1]
    duration_ms = int(round(n / SR * 1000))
    timings: dict[str, float] = {}

    # Transitions only ever touch a song's opening and its last minute, so only those are
    # separated (the stems stay full length, silent in between, so every position still means
    # the same thing). Short songs are separated whole.
    head, tail = int(head_sec * SR), int(tail_sec * SR)
    edges = head > 0 and tail > 0 and n > head + tail + 10 * SR
    ranges = [(0, head), (n - tail, n)] if edges else [(0, n)]

    t = time.time()
    if edges:
        stems = {}
        for a, b in ranges:
            for name, x in separate(wav[:, a:b], stem_model, device, shifts).items():
                stems.setdefault(name, np.zeros_like(wav))[:, a:b] = x
    else:
        stems = separate(wav, stem_model, device, shifts)
    timings["stemsSec"] = round(time.time() - t, 1)
    stems_dir.mkdir(parents=True, exist_ok=True)
    stem_files = {}
    for name, x in stems.items():
        f = stems_dir / f"{name}.flac"
        sf.write(f, x.T, SR, subtype="PCM_16")
        stem_files[name] = f.name
    curves = stem_curves(stems)

    t = time.time()
    beat_model = "beat_this:final0"
    try:
        beats, downbeats, beat_model = beats_beat_this(wav, device)
    except Exception as err:  # noqa: BLE001 - any model failure falls back to madmom
        log(f"Beat This! failed ({err}); using madmom")
        beats, downbeats, beat_model = beats_madmom(wav)
    timings["beatsSec"] = round(time.time() - t, 1)

    t = time.time()
    segments: list[dict] = []
    structure_model = None
    try:
        if edges:
            # Only the exit is chosen from the structure: read the last minute, and drop the
            # boundary the model always puts at the start of what it is given.
            a = ranges[-1][0]
            segs, _, structure_model = structure_allin1({k: v[:, a:] for k, v in stems.items()}, device)
            off = a / SR
            segments = [{**g, "start": g["start"] + off, "end": g["end"] + off}
                        for g in segs if g["start"] > 1.0]
        else:
            segments, _, structure_model = structure_allin1(stems, device)
    except Exception as err:  # noqa: BLE001 - structure is optional for the planner
        log(f"All-In-One failed: {err}")
    timings["structureSec"] = round(time.time() - t, 1)

    del stems
    gc.collect()

    ms = lambda s: int(round(s * 1000))  # noqa: E731
    bpm = None
    if len(beats) > 8:
        bpm = round(60.0 / float(np.median(np.diff(beats))), 2)
    result = {
        "v": 1,
        "models": {"stems": stem_model, "beats": beat_model, "structure": structure_model},
        "durationMs": duration_ms,
        "bpm": bpm,
        "beatsMs": [ms(b) for b in beats],
        "downbeatsMs": [ms(d) for d in downbeats],
        "segments": [
            {"startMs": ms(s["start"]), "endMs": ms(s["end"]), "label": s["label"]}
            for s in segments
        ],
        "stemCurves": {"stepMs": CURVE_STEP_MS, **curves},
        "stemFiles": stem_files,
        "analysedMs": [[ms(a / SR), ms(b / SR)] for a, b in ranges],
        "timings": {**timings, "totalSec": round(time.time() - t0, 1)},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result))
    return result


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio", nargs="?", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--stems-dir", type=Path)
    p.add_argument("--batch", type=Path, help="analyze every .mp3 in this directory, one at a time")
    p.add_argument("--out-dir", type=Path, help="batch mode: <name>.json and <name>/ stems go here")
    p.add_argument("--device", default="auto", help="auto | cpu | mps | cuda")
    p.add_argument("--stem-model", default="htdemucs_ft")
    p.add_argument("--shifts", type=int, default=1, help="Demucs random shifts (quality vs time)")
    p.add_argument("--head-sec", type=float, default=0,
                   help="separate only the first N seconds and the last --tail-sec (0 = whole song)")
    p.add_argument("--tail-sec", type=float, default=0)
    p.add_argument("--force", action="store_true", help="batch: redo songs that already have a result")
    args = p.parse_args()
    device = pick_device(args.device)
    torch.set_num_threads(max(1, os.cpu_count() or 1))

    if args.batch:
        out_dir = args.out_dir or args.batch / "ai"
        files = sorted(args.batch.glob("*.mp3"))
        for i, f in enumerate(files, 1):
            out = out_dir / f"{f.stem}.json"
            if out.exists() and not args.force:
                log(f"[{i}/{len(files)}] {f.stem}: cached")
                continue
            log(f"[{i}/{len(files)}] {f.stem} ...")
            r = analyze(f, out, out_dir / f.stem, device, args.stem_model, args.shifts,
                        head_sec=args.head_sec, tail_sec=args.tail_sec)
            log(f"    bpm {r['bpm']} beats {len(r['beatsMs'])} downbeats {len(r['downbeatsMs'])} "
                f"segments {[s['label'] for s in r['segments']]} {r['timings']}")
        return

    if not args.audio or not args.out:
        p.error("give an audio file and --out (or --batch)")
    stems_dir = args.stems_dir or args.out.with_suffix("")
    r = analyze(args.audio, args.out, stems_dir, device, args.stem_model, args.shifts,
                head_sec=args.head_sec, tail_sec=args.tail_sec)
    log(json.dumps({k: r[k] for k in ("models", "bpm", "timings")}))
    print(json.dumps({"out": str(args.out), "stemsDir": str(stems_dir)}))


if __name__ == "__main__":
    main()
