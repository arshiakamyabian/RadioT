'use client';

import { useEffect } from 'react';
import { useRadio } from '@/lib/radio';

const DEFAULT_HUE = 72;

/** Hue of the artwork's most colourful pixels, or null when it is greyscale or unreadable. */
function artworkHue(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 24;
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        if (!cx) return resolve(null);
        cx.drawImage(img, 0, 0, size, size);
        const d = cx.getImageData(0, 0, size, size).data;
        // Average hue as a vector, weighted by saturation, so vivid pixels win over grey ones.
        let x = 0;
        let y = 0;
        let weight = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]! / 255;
          const g = d[i + 1]! / 255;
          const b = d[i + 2]! / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const c = max - min;
          if (c < 0.12 || max < 0.15) continue;
          let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
          h *= 60;
          const w = c * c;
          x += Math.cos((h * Math.PI) / 180) * w;
          y += Math.sin((h * Math.PI) / 180) * w;
          weight += w;
        }
        if (weight < 2) return resolve(null);
        // sRGB hue → roughly OKLCH hue (OKLCH red sits near 30°, sRGB red at 0°).
        const hsl = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        resolve((hsl + 25) % 360);
      } catch {
        resolve(null); // tainted canvas: artwork served without CORS
      }
    };
    img.src = url;
  });
}

/**
 * Stage lighting: slow drifting colour behind every page, tinted by the song on air.
 * Sets --dyn-h on <html>; every brand/primary colour derives from it.
 */
export function Ambient() {
  const { now } = useRadio();
  const art = now?.artworkUrl ?? null;

  useEffect(() => {
    let cancelled = false;
    const root = document.documentElement;
    if (!art) {
      root.style.setProperty('--dyn-h', String(DEFAULT_HUE));
      return;
    }
    void artworkHue(art).then((h) => {
      if (!cancelled) root.style.setProperty('--dyn-h', String(Math.round(h ?? DEFAULT_HUE)));
    });
    return () => {
      cancelled = true;
    };
  }, [art]);

  return (
    <div className="aurora" aria-hidden>
      <i />
      <i />
      <i />
    </div>
  );
}
