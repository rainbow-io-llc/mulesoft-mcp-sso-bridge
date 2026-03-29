import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireBearerToken } from '../oauth/middleware.js';

export function mcpRouter(proxy) {
  const router = Router();

  // All /mcp routes require a valid Bearer token
  router.use('/mcp', requireBearerToken);

  // ─── POST /mcp ─ Client → Server messages ──────────────────────────────────
  router.post('/mcp', async (req, res) => {
    const body = req.body;

    if (!body || body.jsonrpc !== '2.0') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Expected JSON-RPC 2.0 body' });
    }

    let sessionId = req.headers['mcp-session-id'];

    // For initialize, create a new session if none exists
    if (body.method === 'initialize') {
      if (!sessionId) {
        sessionId = randomUUID();
      }
      proxy.createSession(sessionId);
    } else {
      if (!sessionId || !proxy.hasSession(sessionId)) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32600, message: 'Missing or unknown Mcp-Session-Id header. Send initialize first.' },
        });
      }
    }

    try {
      const response = await proxy.sendRequest(sessionId, body);

      res.set('Mcp-Session-Id', sessionId);

      // Check if client accepts SSE — respond with SSE event if so
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/event-stream')) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
      } else {
        res.json(response);
      }
    } catch (err) {
      console.error('[mcp] proxy error:', err);
      res.status(500).json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: 'Internal error proxying to MCP server' },
      });
    }
  });

  // ─── GET /mcp ─ SSE stream for server-initiated notifications ─────────────
  router.get('/mcp', (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (!sessionId || !proxy.hasSession(sessionId)) {
      return res.status(400).json({ error: 'session_not_found', error_description: 'Unknown or missing Mcp-Session-Id' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
    });
    res.flushHeaders();

    // Send a heartbeat comment every 15s to keep the connection alive
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    const onNotification = (message) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    proxy.on('notification', onNotification);

    req.on('close', () => {
      clearInterval(heartbeat);
      proxy.removeListener('notification', onNotification);
    });
  });

  // ─── DELETE /mcp ─ Session teardown ───────────────────────────────────────
  router.delete('/mcp', (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      proxy.deleteSession(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  return router;
}
