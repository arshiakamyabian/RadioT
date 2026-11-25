import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  images: {
    remotePatterns: [
      // Vercel Blob (artwork and media).
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
  // Without a shared custom domain, the API is served through the web origin so its session cookie is first-party.
  // The stream engine is served through the site's own origin too: networks that block its host
  // name (offices, schools) still play the radio if they can open the site, and HLS segments get
  // cached at the edge.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    const engine = process.env.NEXT_PUBLIC_ENGINE_URL?.replace(/\/$/, '');
    return [
      ...(target ? [{ source: '/api/:path*', destination: `${target}/api/:path*` }] : []),
      ...(engine ? [{ source: '/stream/:path*', destination: `${engine}/:path*` }] : []),
    ];
  },
};

export default withNextIntl(config);
