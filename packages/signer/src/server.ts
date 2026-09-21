// A thin HTTP face for the signer: POST /execute with { authorization, call },
// and POST /sign-typed-data with { authorization, typedData } (Phase 18).
// No auth of its own by design — the signer is reachable only from inside the
// deployment's network, and the authorization *is* the credential: a request
// without a valid one does nothing. Exposing this port to the internet would
// be a deployment error, and docs/wallet/runbook.md says so.

import { createServer, type Server } from 'http';
import type { Signer, ExecuteRequest, SignTypedDataRequest } from './signer';

export function createSignerServer(signer: Signer): Server {
  return createServer(async (req, res) => {
    const route = req.method === 'POST' && (req.url === '/execute' || req.url === '/sign-typed-data') ? req.url : null;
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST /execute or POST /sign-typed-data' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: ExecuteRequest & SignTypedDataRequest;
    try {
      parsed = JSON.parse(body) as ExecuteRequest & SignTypedDataRequest;
      if (!parsed?.authorization) throw new Error('authorization is required');
      if (route === '/execute' && !parsed.call) throw new Error('authorization and call are required');
      if (route === '/sign-typed-data' && !parsed.typedData) throw new Error('authorization and typedData are required');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    const result = route === '/execute' ? await signer.execute(parsed) : await signer.signTypedData(parsed);
    res.writeHead(result.ok ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}
