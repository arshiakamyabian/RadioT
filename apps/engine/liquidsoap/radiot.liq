# RadioT stream engine: one continuous program, encoded once, served as HLS (64k/128k/256k AAC)
# and as an Icecast MP3 fallback. The engine (src/) pushes the pieces to play; this script only
# sequences them gaplessly, crossfades where asked, protects the peaks and encodes.
#
# Environment: LIQ_TELNET_PORT, HLS_DIR, ICECAST_PORT, ICECAST_SOURCE_PASSWORD, ENGINE_URL,
#              HLS_SEGMENT_SECONDS, HLS_SEGMENTS

def env(name, default_value) =
  environment.get(default=default_value, name)
end

settings.log.level := 3
settings.server.telnet := true
settings.server.telnet.port := int_of_string(env("LIQ_TELNET_PORT", "1234"))
settings.server.telnet.bind_addr := "127.0.0.1"
settings.init.allow_root := true

# Pieces arrive as files already cut to length by the engine; gain comes from liq_amplify.
queue = request.queue(id="radio", interactive=true, prefetch=2)

# Per-piece gain, then a crossfade only where a piece asks for one (liq_cross_duration, seconds).
# Every other junction is a plain gapless join: the spliced pieces are sample-exact by design.
radio = amplify(1.0, override="liq_amplify", queue)
radio = crossfade(
  duration=0.,
  fade_in=0.,
  fade_out=0.,
  override_duration="liq_cross_duration",
  deduplicate=false,
  radio
)

# Safety net: if the engine falls behind, play silence rather than stopping the outputs.
radio = mksafe(radio)

# Final peak protection (a brick-wall, only ever acts on rare overs).
radio = limit(threshold=-1.5, ratio=30., attack=5., release=80., radio)

# Tell the engine when a piece goes on air (Liquidsoap clock, before encoding delay).
engine_url = env("ENGINE_URL", "http://127.0.0.1:4200")
def notify(m) =
  ignore(
    http.post(
      "#{engine_url}/liq/on-air",
      headers=[("content-type", "application/json")],
      data=json.stringify(compact=true, m),
      timeout=2.
    )
  )
end
def on_air(m) =
  if m["radiot_id"] != "" then
    notify(m)
  end
end
radio.on_metadata(synchronous=false, on_air)

hls_dir = env("HLS_DIR", "hls")
segment = float_of_string(env("HLS_SEGMENT_SECONDS", "2"))
segments = int_of_string(env("HLS_SEGMENTS", "10"))
aac_64k = %ffmpeg(format="mpegts", %audio(codec="aac", b="64k", ar=44100, ac=2))
aac_128k = %ffmpeg(format="mpegts", %audio(codec="aac", b="128k", ar=44100, ac=2))
aac_256k = %ffmpeg(format="mpegts", %audio(codec="aac", b="256k", ar=44100, ac=2))

output.file.hls(
  id="hls",
  playlist="radiot.m3u8",
  segment_duration=segment,
  segments=segments,
  segments_overhead=4,
  persist_at="#{hls_dir}/state.config",
  hls_dir,
  [
    ("aac_64k", aac_64k.{bandwidth=72000, codecs="mp4a.40.2"}),
    ("aac_128k", aac_128k.{bandwidth=140000, codecs="mp4a.40.2"}),
    ("aac_256k", aac_256k.{bandwidth=270000, codecs="mp4a.40.2"})
  ],
  radio
)

# The MP3 fallback for old devices (no HLS, no MSE).
mp3_128k = %ffmpeg(format="mp3", %audio(codec="libmp3lame", b="128k", ar=44100, ac=2))

output.icecast(
  id="icecast",
  mp3_128k,
  format="audio/mpeg",
  host="127.0.0.1",
  port=int_of_string(env("ICECAST_PORT", "8000")),
  password=env("ICECAST_SOURCE_PASSWORD", "radiot-source"),
  mount="/radiot.mp3",
  name="RadioT",
  description="RadioT live community radio (MP3 fallback)",
  public=false,
  radio
)
