import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { clients, codes, tokens } from './store.js';
import { verifyS256Challenge } from './pkce.js';
import { signToken } from './jwt.js';
import { config } from '../config.js';

// Stores pending PKCE state per client_id while the user is on the Anypoint login page.
// Key: client_id  Value: { code_challenge, code_challenge_method, claudeRedirectUri, scope, expiresAt }
const pendingAuthorizes = new Map();

export function oauthRouter() {
  const router = Router();

  // ─── Discovery: OAuth Protected Resource Metadata (RFC 9728) ─────────────────
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
      clientSecret: null,
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
  // Validates Claude Desktop's PKCE request, stores the challenge, then redirects
  // to Anypoint Platform's login page. Anypoint sends the code back directly to
  // Claude Desktop via https://claude.ai/api/mcp/auth_callback (registered in Anypoint).
  router.get('/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

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
    if (!clients.has(client_id)) {
      console.log(`[oauth] Auto-registering client: ${client_id}`);
      clients.set(client_id, {
        clientId: client_id,
        clientSecret: null,
        redirectUris: [redirect_uri],
        grantTypes: ['authorization_code'],
        scope: 'mcp',
        clientName: 'Claude Desktop',
        createdAt: Date.now(),
      });
    }

    // Save PKCE state keyed by client_id so we can verify it in /token.
    // Claude Desktop will send the code_verifier there after Anypoint redirects back.
    pendingAuthorizes.set(client_id, {
      code_challenge,
      code_challenge_method,
      claudeRedirectUri: redirect_uri,   // e.g. https://claude.ai/api/mcp/auth_callback
      scope: scope ?? 'mcp',
      expiresAt: Date.now() + config.authCodeTtl * 1000,
    });

    // Redirect to Anypoint login.
    // redirect_uri MUST match what is registered in the Anypoint Connected App.
    // We pass Claude Desktop's own state through so Claude can validate it on return.
    const anypointUrl = new URL(config.anypoint.authorizeUrl);
    anypointUrl.searchParams.set('response_type', 'code');
    anypointUrl.searchParams.set('client_id', config.anypoint.clientId);
    anypointUrl.searchParams.set('redirect_uri', redirect_uri);  // https://claude.ai/api/mcp/auth_callback
    anypointUrl.searchParams.set('scope', config.anypoint.oauthScope);
    if (state) anypointUrl.searchParams.set('state', state);

    console.log(`[oauth] Redirecting to Anypoint login (client: ${client_id})`);
    res.redirect(anypointUrl.toString());
  });

  // ─── Token Endpoint ───────────────────────────────────────────────────────────
  // Claude Desktop calls this after Anypoint redirects back to claude.ai with the code.
  // Two code types are handled:
  //   1. Our own bridge code (in the local codes Map) — for future local-auth flows
  //   2. An Anypoint authorization code — exchange it with Anypoint, then issue our JWT
  router.post('/token', async (req, res) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
    }

    // ── Path 1: our own bridge code ──────────────────────────────────────────
    const localRecord = codes.get(code);
    if (localRecord) {
      return handleLocalCode(req, res, localRecord, { code, redirect_uri, client_id, code_verifier });
    }

    // ── Path 2: Anypoint authorization code ─────────────────────────────────
    const pending = pendingAuthorizes.get(client_id);
    if (!pending) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'No pending authorization for this client. Start the flow again.' });
    }
    if (pending.expiresAt < Date.now()) {
      pendingAuthorizes.delete(client_id);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization session expired. Start the flow again.' });
    }

    // Verify PKCE — the code_verifier must match the code_challenge from /authorize
    if (!verifyS256Challenge(code_verifier, pending.code_challenge)) {
      pendingAuthorizes.delete(client_id);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
    }

    // Verify redirect_uri matches what was used in /authorize
    if (redirect_uri !== pending.claudeRedirectUri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Exchange the Anypoint code for an Anypoint access token
    let anypointToken;
    try {
      anypointToken = await exchangeAnypointCode(code, redirect_uri);
    } catch (err) {
      console.error('[oauth] Anypoint token exchange failed:', err.message);
      return res.status(502).json({ error: 'upstream_error', error_description: `Anypoint token exchange failed: ${err.message}` });
    }

    // Get the authenticated user's identity from Anypoint
    let userId;
    try {
      userId = await getAnypointUserId(anypointToken.access_token);
    } catch (err) {
      console.error('[oauth] Anypoint userinfo failed:', err.message);
      userId = anypointToken.username ?? anypointToken.sub ?? 'anypoint-user';
    }

    console.log(`[oauth] Anypoint SSO success — user: ${userId}, client: ${client_id}`);
    pendingAuthorizes.delete(client_id);

    // Issue our JWT access token (sub = Anypoint user identity)
    const { token, jti, expiresAt } = await signToken({
      sub: userId,
      scope: pending.scope,
    });

    tokens.set(jti, {
      clientId: client_id,
      userId,
      scope: pending.scope,
      expiresAt,
    });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope: pending.scope,
    });
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function handleLocalCode(req, res, record, { code, redirect_uri, client_id, code_verifier }) {
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
  if (!verifyS256Challenge(code_verifier, record.codeChallenge)) {
    codes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
  }

  codes.delete(code); // single-use

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
}

async function exchangeAnypointCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
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
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  return resp.json();
}

async function getAnypointUserId(accessToken) {
  const resp = await fetch(config.anypoint.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = await resp.json();
  // Anypoint /accounts/api/me returns { username, email, id, ... }
  return data.username ?? data.email ?? data.id ?? 'anypoint-user';
}
