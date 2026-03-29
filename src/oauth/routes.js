import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { clients, codes, tokens } from './store.js';
import { verifyS256Challenge } from './pkce.js';
import { signToken } from './jwt.js';
import { config } from '../config.js';

export function oauthRouter() {
  const router = Router();

  // ─── Discovery: OAuth Protected Resource Metadata (RFC 9728) ─────────────────
  // MCP spec requires this endpoint so clients know which auth server to use.
  router.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = config.publicUrl;
    res.json({
      resource: base,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://docs.mulesoft.com/mulesoft-mcp-server',
    });
  });

  // ─── Discovery: OAuth Authorization Server Metadata (RFC 8414) ───────────────
  router.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = config.publicUrl;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
  router.post('/register', (req, res) => {
    const { redirect_uris, grant_types, token_endpoint_auth_method, client_name } = req.body;

    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }

    const grantTypes = grant_types ?? ['authorization_code'];
    if (!grantTypes.includes('authorization_code')) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'authorization_code grant is required' });
    }

    const clientId = randomUUID();
    const now = Date.now();

    clients.set(clientId, {
      clientId,
      clientSecret: null,   // public client — PKCE only
      redirectUris: redirect_uris,
      grantTypes,
      scope: 'mcp',
      clientName: client_name ?? 'Unknown Client',
      createdAt: now,
    });

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: token_endpoint_auth_method ?? 'none',
      scope: 'mcp',
    });
  });

  // ─── Authorization Endpoint ───────────────────────────────────────────────────
  // Validates Claude Desktop's OAuth request, then redirects to Anypoint Platform
  // login page. The user authenticates with their Anypoint credentials there.
  router.get('/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

    // Validate required params
    if (response_type !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    }
    if (code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' });
    }

    // Auto-register Claude Desktop as a public client if it skipped /register
    let client = clients.get(client_id);
    if (!client) {
      console.log(`[oauth] Auto-registering client: ${client_id}`);
      client = {
        clientId: client_id,
        clientSecret: null,
        redirectUris: [redirect_uri],
        grantTypes: ['authorization_code'],
        scope: 'mcp',
        clientName: 'Claude Desktop',
        createdAt: Date.now(),
      };
      clients.set(client_id, client);
    } else if (!client.redirectUris.includes(redirect_uri)) {
      client.redirectUris.push(redirect_uri);
    }

    // Save the full Claude Desktop authorize request in the session so we can
    // resume it after the user logs in via Anypoint.
    req.session.pendingAuthorize = { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope };

    // Generate a random bridgeState to bind the Anypoint callback to this session.
    // We pass it as `state` to Anypoint so we can verify it on return.
    const bridgeState = randomBytes(16).toString('hex');
    req.session.bridgeState = bridgeState;

    // Build the Anypoint OAuth authorization URL
    const anypointAuthUrl = new URL(config.anypoint.authorizeUrl);
    anypointAuthUrl.searchParams.set('response_type', 'code');
    anypointAuthUrl.searchParams.set('client_id', config.anypoint.clientId);
    anypointAuthUrl.searchParams.set('redirect_uri', `${config.publicUrl}/callback`);
    anypointAuthUrl.searchParams.set('scope', config.anypoint.oauthScope);
    anypointAuthUrl.searchParams.set('state', bridgeState);

    console.log(`[oauth] Redirecting to Anypoint login for client ${client_id}`);
    res.redirect(anypointAuthUrl.toString());
  });

  // ─── Anypoint OAuth Callback ──────────────────────────────────────────────────
  // Anypoint redirects here after the user authenticates. We exchange the
  // Anypoint code for a token, get the user's identity, then issue our own
  // authorization code back to Claude Desktop.
  router.get('/callback', async (req, res) => {
    const { code: anypointCode, state, error, error_description } = req.query;

    // Handle Anypoint login errors (e.g. user denied)
    if (error) {
      console.error(`[oauth] Anypoint login error: ${error} — ${error_description}`);
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:40px">
          <h2>Authentication Failed</h2>
          <p><strong>${error}</strong>: ${error_description ?? 'The Anypoint login was denied or failed.'}</p>
          <p>Close this window and try again.</p>
        </body></html>
      `);
    }

    // Validate state to prevent CSRF (bind Anypoint callback to this session)
    if (!state || state !== req.session.bridgeState) {
      console.error('[oauth] State mismatch in /callback — possible CSRF');
      return res.status(400).json({ error: 'invalid_state', error_description: 'OAuth state mismatch' });
    }

    if (!anypointCode) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code from Anypoint' });
    }

    const pendingAuthorize = req.session.pendingAuthorize;
    if (!pendingAuthorize) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'No pending authorization — session may have expired' });
    }

    // Exchange the Anypoint code for an access token
    let anypointToken;
    try {
      anypointToken = await exchangeAnypointCode(anypointCode);
    } catch (err) {
      console.error('[oauth] Anypoint token exchange failed:', err.message);
      return res.status(502).json({ error: 'upstream_error', error_description: 'Failed to exchange code with Anypoint Platform' });
    }

    // Get the authenticated user's identity from Anypoint
    let userId;
    try {
      userId = await getAnypointUserId(anypointToken.access_token);
    } catch (err) {
      console.error('[oauth] Failed to get Anypoint user info:', err.message);
      // Fall back to the sub claim in the token if userinfo fails
      userId = anypointToken.username ?? 'anypoint-user';
    }

    console.log(`[oauth] Anypoint SSO success for user: ${userId}`);

    // Clear session state
    req.session.bridgeState = null;
    req.session.pendingAuthorize = null;
    req.session.userId = userId;

    // Issue our authorization code back to Claude Desktop
    issueCode(req, res, pendingAuthorize, userId);
  });

  // ─── Token Endpoint ───────────────────────────────────────────────────────────
  router.post('/token', async (req, res) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    }

    const record = codes.get(code);
    if (!record) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code not found or expired' });
    }
    if (record.expiresAt < Date.now()) {
      codes.delete(code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    }
    if (record.clientId !== client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    }
    if (record.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Verify PKCE
    if (!verifyS256Challenge(code_verifier, record.codeChallenge)) {
      codes.delete(code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
    }

    // Single-use: delete code immediately
    codes.delete(code);

    // Issue our JWT access token (sub = Anypoint user identity)
    const { token, jti, expiresAt } = await signToken({
      sub: record.userId,
      scope: record.scope ?? 'mcp',
    });

    tokens.set(jti, {
      clientId: client_id,
      userId: record.userId,
      scope: record.scope ?? 'mcp',
      expiresAt,
    });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope: record.scope ?? 'mcp',
    });
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function issueCode(req, res, pendingAuthorize, userId) {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = pendingAuthorize;

  const code = randomBytes(32).toString('base64url');
  codes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    userId,
    scope: scope ?? 'mcp',
    expiresAt: Date.now() + config.authCodeTtl * 1000,
  });

  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);

  res.redirect(callbackUrl.toString());
}

async function exchangeAnypointCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${config.publicUrl}/callback`,
    client_id: config.anypoint.clientId,
    client_secret: config.anypoint.clientSecret,
  });

  const resp = await fetch(config.anypoint.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anypoint token endpoint returned ${resp.status}: ${text}`);
  }

  return resp.json();
}

async function getAnypointUserId(accessToken) {
  const resp = await fetch(config.anypoint.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    throw new Error(`Anypoint userinfo returned ${resp.status}`);
  }

  const data = await resp.json();
  // Anypoint /accounts/api/me returns { username, email, ... }
  return data.username ?? data.email ?? data.id ?? 'anypoint-user';
}
