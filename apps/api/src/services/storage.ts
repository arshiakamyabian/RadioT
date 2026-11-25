import { BlobNotFoundError, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import type { Env } from '../env.js';

/** Vercel Blob. Browsers upload straight to Blob with a short-lived client token scoped to one path. */
export function createApiStorage(env: Env) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const requireToken = () => {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set; connect a Blob store');
    return token;
  };
  return {
    async clientUpload(pathname: string, contentType: string, maxBytes: number) {
      const clientToken = await generateClientTokenFromReadWriteToken({
        token: requireToken(),
        pathname,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
        validUntil: Date.now() + 15 * 60_000,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return { pathname, token: clientToken, contentType };
    },
    async head(pathname: string): Promise<{ size: number } | null> {
      try {
        const res = await head(pathname, { token: requireToken() });
        return { size: res.size };
      } catch (err) {
        if (err instanceof BlobNotFoundError) return null;
        throw err;
      }
    },
  };
}
export type ApiStorage = ReturnType<typeof createApiStorage>;
