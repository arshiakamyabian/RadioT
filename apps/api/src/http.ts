import type { FastifyReply, FastifyRequest } from 'fastify';

export function toWebHeaders(raw: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.append(key, String(value));
  }
  return headers;
}

export function toWebRequest(request: FastifyRequest, baseUrl: string): Request {
  const url = new URL(request.url, baseUrl);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body != null;
  return new Request(url, {
    method: request.method,
    headers: toWebHeaders(request.headers),
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
}

export async function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  // Set-Cookie must stay as separate headers; Headers#forEach would join them with commas.
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') reply.header(key, value);
  });
  return reply.send(response.body ? await response.text() : null);
}
