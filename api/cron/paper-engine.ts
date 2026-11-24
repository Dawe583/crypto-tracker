import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostedCron } from '../../src/engine/hosted-api.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { status, body } = await hostedCron(req.method, req.headers.authorization);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
