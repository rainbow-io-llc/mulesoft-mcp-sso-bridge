import { SignJWT, jwtVerify, base64url } from 'jose';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

let _secret = null;

function getSecret() {
  if (!_secret) {
    _secret = base64url.decode(config.jwtSecret);
  }
  return _secret;
}

/**
 * Sign a JWT access token.
 * @param {object} claims - Additional claims to include (sub, scope, etc.)
 * @returns {Promise<{ token: string, jti: string, expiresAt: number }>}
 */
export async function signToken(claims) {
  const jti = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.accessTokenTtl;

  const token = await new SignJWT({ ...claims, jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.jwtIssuer)
    .setAudience('mulesoft-mcp')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecret());

  return { token, jti, expiresAt: exp * 1000 };
}

/**
 * Verify and decode a JWT access token.
 * @param {string} token
 * @returns {Promise<object>} Decoded payload
 * @throws If token is invalid or expired
 */
export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: config.jwtIssuer,
    audience: 'mulesoft-mcp',
  });
  return payload;
}
