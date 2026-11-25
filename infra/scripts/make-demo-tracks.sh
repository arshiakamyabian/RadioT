#!/usr/bin/env bash
# Synthesizes royalty-free demo tracks into content/fallback/ for local development.
# Each has leading silence, a quiet tail and a different loudness so the analyzer has real work to do.
set -euo pipefail
out="${1:-$(dirname "$0")/../../content/fallback}"
mkdir -p "$out"
dur="${DEMO_DURATION:-50}"

make() { # name title freq bpm gain
  local name=$1 title=$2 f=$3 bpm=$4 gain=$5
  local beat; beat=$(awk "BEGIN{print 60/$bpm}")
  ffmpeg -loglevel error -y \
    -f lavfi -i "anullsrc=r=44100:cl=stereo:d=1.2" \
    -f lavfi -i "aevalsrc='$gain*(0.5*sin(2*PI*$f*t)+0.3*sin(2*PI*$f*1.5*t)+0.2*sin(2*PI*$f*2*t))*(0.6+0.4*sin(2*PI*t/$beat))+$gain*0.8*sin(2*PI*55*t)*exp(-12*mod(t,$beat))':s=44100:d=$dur,afade=t=out:st=$((dur-6)):d=6,pan=stereo|c0=c0|c1=c0" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo:d=1.5" \
    -filter_complex "[0][1][2]concat=n=3:v=0:a=1" \
    -metadata title="$title" -metadata artist="RadioT Demo" \
    -c:a libmp3lame -b:a 192k "$out/$name.mp3"
  echo "made $out/$name.mp3"
}

make demo-01-sunrise "Sunrise Loop" 220 96 0.35
make demo-02-bosphorus "Bosphorus Drift" 261.63 110 0.6
make demo-03-night-bus "Night Bus" 196 84 0.2
make demo-04-tea-garden "Tea Garden" 293.66 120 0.5
make demo-05-ferry "Last Ferry" 246.94 100 0.8
