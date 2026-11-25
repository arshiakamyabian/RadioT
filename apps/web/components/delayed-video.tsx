'use client';

import { useEffect, useRef } from 'react';

const FPS = 10;
const MAX_DELAY_S = 15;

/**
 * Plays a WebRTC video track `delaySeconds` late so it lines up with what the listener hears
 * over HLS. Frames are sampled into a small downscaled ring buffer and painted when due.
 */
export function DelayedVideo({
  track,
  delaySeconds,
  label,
}: {
  track: MediaStreamTrack;
  delaySeconds: number;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const delay = Math.min(MAX_DELAY_S, Math.max(0, delaySeconds));
  const direct = delay < 0.5;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = new MediaStream([track]);
    void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [track]);

  useEffect(() => {
    if (direct) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const ctx = c.getContext('2d');
    const queue: { at: number; frame: ImageBitmap }[] = [];
    let stopped = false;
    const capture = setInterval(async () => {
      if (v.readyState < 2 || !v.videoWidth) return;
      const frame = await createImageBitmap(v, {
        resizeWidth: 480,
        resizeHeight: Math.round((480 * v.videoHeight) / v.videoWidth),
      });
      if (stopped) return frame.close();
      queue.push({ at: performance.now(), frame });
    }, 1000 / FPS);
    let raf = 0;
    const paint = () => {
      const due = performance.now() - delay * 1000;
      let latest: ImageBitmap | null = null;
      while (queue.length && queue[0]!.at <= due) {
        latest?.close();
        latest = queue.shift()!.frame;
      }
      if (latest && ctx) {
        c.width = latest.width;
        c.height = latest.height;
        ctx.drawImage(latest, 0, 0);
        latest.close();
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      stopped = true;
      clearInterval(capture);
      cancelAnimationFrame(raf);
      queue.forEach((q) => q.frame.close());
    };
  }, [delay, direct]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={label}
        className={
          direct ? 'size-full object-cover' : 'pointer-events-none absolute size-px opacity-0'
        }
      />
      {!direct && (
        <canvas ref={canvasRef} role="img" aria-label={label} className="size-full object-cover" />
      )}
    </div>
  );
}
