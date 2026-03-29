import { createHash } from 'node:crypto';

/**
 * Verify a PKCE S256 code challenge.
 * SHA-256(code_verifier) encoded as base64url must equal code_challenge.
 * Per RFC 7636 §4.6 — only S256 is supported (plain is rejected per OAuth 2.1).
 */
export function verifyS256Challenge(codeVerifier, codeChallenge) {
  const computed = createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  return computed === codeChallenge;
}
