const paths = new Set(['/api/engine/snapshot', '/api/engine/strategies', '/api/engine/decisions',
  '/api/engine/candles', '/api/engine/kill', '/api/whales', '/api/pools', '/api/gold']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const requested = new URL(req.url, 'https://deck.invalid');
  if (!paths.has(requested.pathname)) return res.status(404).json({ error: 'Not found' });
  const method = requested.pathname === '/api/engine/kill' ? 'POST' : 'GET';
  if (req.method !== method) return res.status(405).json({ error: 'Method not allowed' });
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (method === 'POST' && !authorization) return res.status(401).json({ error: 'API token required' });
  if (!process.env.ENGINE_API_ORIGIN) return res.status(503).json({ error: 'Engine origin is not configured' });
  try {
    const origin = new URL(process.env.ENGINE_API_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return res.status(503).json({ error: 'Engine origin must be an HTTPS origin' });
    }
    const upstream = await fetch(new URL(requested.pathname + requested.search, origin), {
      method, headers: authorization ? { authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(8000),
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
