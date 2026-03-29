/**
 * In-memory stores for OAuth 2.1 state.
 * All maps are keyed by their primary identifier and include an expiresAt timestamp.
 * A background sweep runs every 5 minutes to remove expired entries.
 */

// clients Map<clientId, ClientRecord>
// ClientRecord: { clientId, clientSecret|null, redirectUris[], grantTypes[], scope, createdAt }
export const clients = new Map();

// codes Map<code, CodeRecord>
// CodeRecord: { clientId, redirectUri, codeChallenge, codeChallengeMethod, userId, scope, expiresAt }
export const codes = new Map();

// tokens Map<jti, TokenRecord>
// TokenRecord: { clientId, userId, scope, expiresAt }
// Used for revocation checks — jti presence means token is valid
export const tokens = new Map();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [key, record] of codes) {
    if (record.expiresAt < now) codes.delete(key);
  }
  for (const [key, record] of tokens) {
    if (record.expiresAt < now) tokens.delete(key);
  }
}

// Start background sweep (unref so it doesn't prevent process exit)
const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref();
