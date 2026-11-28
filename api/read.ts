import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostedRead, hostedReadPaths } from '../src/engine/hosted-api.js';

type VercelRequest = IncomingMessage & { query?: Record<string, string | string[]> };
type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const requested = new URL(req.url ?? '/', 'https://deck.invalid');
  const routedPath = req.query?.__deck_path ?? requested.searchParams.get('__deck_path');
  if (typeof routedPath === 'string') requested.pathname = `/api/${routedPath}`;
  requested.searchParams.delete('__deck_path');
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (!process.env.ENGINE_API_ORIGIN) {
    const { status, body } = await hostedRead(requested, req.method, authorization);
    return res.status(status).json(body);
  }
  if (!hostedReadPaths.has(requested.pathname)) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const origin = new URL(process.env.ENGINE_API_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return res.status(503).json({ error: 'Engine origin must be an HTTPS origin' });
    }
    const upstream = await fetch(new URL(requested.pathname + requested.search, origin), {
      method: 'GET', headers: authorization ? { authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(upstream.status).json({ error: 'Engine access denied' });
    }
    if (!upstream.headers.get('content-type')?.includes('application/json')) {
      return res.status(502).json({ error: 'Engine returned a non-JSON response' });
    }
    return res.status(upstream.status).json(await upstream.json());
  } catch {
    return res.status(502).json({ error: 'Engine is unreachable' });
  }
}
