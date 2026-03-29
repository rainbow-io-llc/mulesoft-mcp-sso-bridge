import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name, defaultValue = undefined) {
  return process.env[name] ?? defaultValue;
}

function anypointBaseUrl(region) {
  switch (region) {
    case 'PROD_EU': return 'https://eu1.anypoint.mulesoft.com';
    case 'PROD_CA': return 'https://ca1.anypoint.mulesoft.com';
    case 'PROD_JP': return 'https://jp1.anypoint.mulesoft.com';
    default:        return 'https://anypoint.mulesoft.com';  // PROD_US
  }
}

const region = optional('ANYPOINT_REGION', 'PROD_US');
const anypointBase = anypointBaseUrl(region);

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),

  jwtSecret: required('JWT_SECRET'),
  jwtIssuer: optional('JWT_ISSUER', 'mulesoft-mcp-bridge'),
  accessTokenTtl: parseInt(optional('ACCESS_TOKEN_TTL', '3600'), 10),
  authCodeTtl: parseInt(optional('AUTH_CODE_TTL', '600'), 10),

  sessionSecret: required('SESSION_SECRET'),

  anypoint: {
    clientId:     required('ANYPOINT_CLIENT_ID'),
    clientSecret: required('ANYPOINT_CLIENT_SECRET'),
    region,
    // Anypoint Connected App OAuth v2 endpoints
    authorizeUrl: `${anypointBase}/accounts/api/v2/oauth2/authorize`,
    tokenUrl:     `${anypointBase}/accounts/api/v2/oauth2/token`,
    userInfoUrl:  `${anypointBase}/accounts/api/me`,
    // Scopes requested from Anypoint during SSO login
    oauthScope: optional('ANYPOINT_OAUTH_SCOPE', 'openid profile email'),
  },

  updateClaudeConfig: optional('UPDATE_CLAUDE_CONFIG', 'false') === 'true',

  // Set at runtime after ngrok tunnel starts
  publicUrl: null,
};
