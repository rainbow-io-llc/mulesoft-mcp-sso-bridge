import { verifyToken } from './jwt.js';
import { tokens } from './store.js';

/**
 * Express middleware that validates a Bearer JWT on every request.
 * Attaches decoded payload to req.auth on success.
 * Returns 401 with WWW-Authenticate header on failure.
 */
export async function requireBearerToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401)
      .set('WWW-Authenticate', 'Bearer realm="mulesoft-mcp", error="unauthorized"')
      .json({ error: 'unauthorized', error_description: 'Bearer token required' });
  }

  try {
    const raw = auth.slice(7);
    const payload = await verifyToken(raw);

    // Check jti is still in the active tokens map (not revoked / server restarted)
    if (!tokens.has(payload.jti)) {
      throw new Error('token not in active store');
    }

    req.auth = payload;
    next();
  } catch {
    res.status(401)
      .set('WWW-Authenticate', 'Bearer realm="mulesoft-mcp", error="invalid_token"')
      .json({ error: 'invalid_token', error_description: 'Token is invalid or expired' });
  }
}
