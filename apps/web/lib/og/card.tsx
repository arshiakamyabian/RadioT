import { ImageResponse } from 'next/og';
import { STATION_NAME } from '@radiot/shared';

export const ogSize = { width: 1200, height: 630 };

/** Shared OG card layout used by every dynamic share image. */
export function ogCard({
  eyebrow,
  title,
  subtitle,
  art,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  art?: string | null;
}) {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: '#0b1220',
        color: '#f7f5ff',
        padding: 64,
        gap: 48,
        alignItems: 'center',
      }}
    >
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element -- rendered by satori, not the browser
        <img
          src={art}
          width={360}
          height={360}
          style={{ borderRadius: 32, objectFit: 'cover' }}
          alt=""
        />
      ) : (
        <div
          style={{
            width: 360,
            height: 360,
            borderRadius: 32,
            background: '#16243a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 160,
          }}
        >
          📻
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 30,
            color: '#5eead4',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 4,
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            fontSize: 76,
            fontWeight: 900,
            lineHeight: 1.05,
            marginTop: 16,
            overflow: 'hidden',
          }}
        >
          {title.slice(0, 60)}
        </div>
        {subtitle ? (
          <div style={{ fontSize: 36, color: '#c3d0e0', marginTop: 20 }}>
            {subtitle.slice(0, 80)}
          </div>
        ) : null}
        <div style={{ fontSize: 40, fontWeight: 900, color: '#5eead4', marginTop: 48 }}>
          {STATION_NAME}
        </div>
      </div>
    </div>,
    ogSize,
  );
}
