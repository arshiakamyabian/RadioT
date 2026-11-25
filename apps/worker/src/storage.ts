import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { put } from '@vercel/blob';
import type { Env } from './env.js';

/** Folder-backed storage for local development (no Blob, nothing leaves the machine). */
function localStorage(dir: string, baseUrl: string) {
  return {
    async download(key: string, file: string) {
      await copyFile(join(dir, key), file);
    },
    async upload(key: string, file: string, _contentType: string) {
      await mkdir(dirname(join(dir, key)), { recursive: true });
      await copyFile(file, join(dir, key));
    },
    publicUrl: (key: string) => `${baseUrl.replace(/\/$/, '')}/${key}`,
  };
}

export function blobBaseUrl(env: Pick<Env, 'BLOB_READ_WRITE_TOKEN' | 'MEDIA_BASE_URL'>) {
  if (env.MEDIA_BASE_URL) return env.MEDIA_BASE_URL.replace(/\/$/, '');
  const storeId = env.BLOB_READ_WRITE_TOKEN?.match(/^vercel_blob_rw_([a-z0-9]+)_/i)?.[1];
  if (!storeId) throw new Error('Set BLOB_READ_WRITE_TOKEN (or MEDIA_BASE_URL)');
  return `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com`;
}

/** Vercel Blob. Raw uploads and cooked media share one public store under unguessable keys. */
export function createStorage(env: Env) {
  if (env.LOCAL_MEDIA_DIR) {
    return localStorage(
      env.LOCAL_MEDIA_DIR,
      env.MEDIA_BASE_URL ?? `http://localhost:${env.PORT}/media`,
    );
  }
  const base = () => blobBaseUrl(env);
  return {
    async download(key: string, file: string) {
      const res = await fetch(`${base()}/${key}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`download ${key} -> ${res.status}`);
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream),
        createWriteStream(file),
      );
    },
    async upload(key: string, file: string, contentType: string) {
      const { size } = await stat(file);
      await put(key, createReadStream(file), {
        access: 'public',
        token: env.BLOB_READ_WRITE_TOKEN,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        cacheControlMaxAge: 31_536_000,
        multipart: size > 50 * 1024 * 1024,
      });
    },
    publicUrl: (key: string) => `${base()}/${key}`,
  };
}
export type Storage = ReturnType<typeof createStorage>;
