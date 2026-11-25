/**
 * Mic enforcement, layer 1: the performer's browser only ever asks for video.
 * (Layer 2: camera-only LiveKit grant. Layer 3: server webhook kicks any audio track.)
 */
export function cameraConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
  };
}

export async function openCamera(
  getUserMedia = (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c),
) {
  const stream = await getUserMedia(cameraConstraints());
  // Belt and braces: if a browser ever hands back audio anyway, stop it before it can be published.
  for (const t of stream.getAudioTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  const video = stream.getVideoTracks()[0];
  if (!video) throw new Error('No camera track');
  return video;
}
