/**
 * A JSON response with the charset every client here expects.
 *
 * Compression is deliberately left to the server: Next compresses handler
 * responses itself and, from 16.4.6, drops a handler's own Content-Encoding,
 * so a body gzipped here would go out gzipped twice (#1729).
 */
export function jsonResponse(_request: Request, data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  // The body still varies by Accept-Encoding: the server compresses it.
  if (Buffer.byteLength(body) >= 1024) headers.set("Vary", "Accept-Encoding");
  return new Response(body, { ...init, headers });
}
