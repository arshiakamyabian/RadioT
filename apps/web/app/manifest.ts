import type { MetadataRoute } from 'next';
import { STATION_NAME, STATION_TAGLINE } from '@radiot/shared';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: STATION_NAME,
    short_name: STATION_NAME,
    description: STATION_TAGLINE,
    start_url: '/',
    display: 'standalone',
    background_color: '#151412',
    theme_color: '#151412',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
