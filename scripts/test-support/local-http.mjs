import { request } from 'node:http';

// Test transport only. Each exchange owns a fresh socket and fully consumes
// its body, so no pooled connection survives synchronous Wrangler commands.
// No request is retried. Only ordinary same-origin GET redirects are followed.
export function localFetch(input, options = {}, redirects = 0) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('LOCAL_HTTP_TARGET_REQUIRED');
  }
  return new Promise((done, fail) => {
    const headers = new Headers(options.headers);
    headers.set('Connection', 'close');
    const body = options.body;
    if (body !== undefined) {
      if (typeof body !== 'string') throw new Error('LOCAL_HTTP_STRING_BODY_REQUIRED');
      headers.set('Content-Length', String(Buffer.byteLength(body)));
    }
    const method = options.method ?? 'GET';
    const req = request(url, { method, agent: false, headers: Object.fromEntries(headers), signal: options.signal }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', fail);
      response.once('end', () => {
        if (method === 'GET' && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          const target = new URL(response.headers.location, url);
          if (target.origin !== url.origin || redirects >= 5) { fail(new Error('LOCAL_REDIRECT_INVALID')); return; }
          localFetch(target.href, options, redirects + 1).then(done, fail);
          return;
        }
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) resultHeaders.append(key, entry);
        }
        done(new Response([204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), {
          status: response.statusCode, headers: resultHeaders,
        }));
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('LOCAL_HTTP_TIMEOUT')));
    req.once('error', fail);
    req.end(body);
  });
}
