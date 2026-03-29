# MuleSoft MCP OAuth Bridge

An OAuth 2.1 bridge server that wraps the local `@mulesoft/mcp-server` and exposes it over HTTPS via ngrok, with Anypoint Platform SSO authentication for Claude Desktop.

## Overview

Claude Desktop requires remote MCP servers to be reachable over HTTPS and protected by OAuth 2.1. The `@mulesoft/mcp-server` runs locally over stdio. This bridge:

1. Spawns `@mulesoft/mcp-server` as a child process
2. Opens an ngrok HTTPS tunnel to expose the local server
3. Implements a full OAuth 2.1 authorization server (with Anypoint SSO)
4. Proxies authenticated MCP requests from Claude Desktop to the child process

```
Claude Desktop
    │  HTTPS + Bearer JWT
    ▼
ngrok tunnel
    │
    ▼
Express server (OAuth 2.1 + MCP proxy)   ← this bridge
    │  stdin/stdout JSON-RPC
    ▼
@mulesoft/mcp-server (child process)
```

## Requirements

- Node.js >= 20
- ngrok account and authtoken (`ngrok config add-authtoken <token>`)
- Anypoint Platform Connected App (see setup below)

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Base64url-encoded secret for signing JWTs. Generate: `openssl rand -base64 32` |
| `SESSION_SECRET` | Yes | Secret for Express session cookies. Generate: `openssl rand -base64 32` |
| `ANYPOINT_CLIENT_ID` | Yes | Anypoint Connected App client ID |
| `ANYPOINT_CLIENT_SECRET` | Yes | Anypoint Connected App client secret |
| `JWT_ISSUER` | No | JWT issuer claim (default: `mulesoft-mcp-bridge`) |
| `ACCESS_TOKEN_TTL` | No | Access token lifetime in seconds (default: `3600`) |
| `AUTH_CODE_TTL` | No | Authorization code lifetime in seconds (default: `600`) |
| `ANYPOINT_REGION` | No | Anypoint region: `PROD_US` (default), `PROD_EU`, `PROD_CA`, `PROD_JP` |
| `PORT` | No | Local port to listen on (default: `3000`) |
| `UPDATE_CLAUDE_CONFIG` | No | Auto-patch `claude_desktop_config.json` on startup (default: `false`) |

### 3. Create an Anypoint Connected App

In **Anypoint Platform → Access Management → Connected Apps**, create an app with:

- **Type**: App acts on its own behalf (client credentials) — but also enable Authorization Code grant
- **Redirect URI**: `https://claude.ai/api/mcp/auth_callback`
- **Scopes**: `openid profile email` (plus any MuleSoft-specific scopes needed)

### 4. Configure ngrok

```sh
ngrok config add-authtoken <your-token>
```

Or set `NGROK_AUTHTOKEN` in your `.env`.

## Running

```sh
# Production
npm start

# Development (auto-restart on file change)
npm run dev
```

On startup the bridge will:
- Spawn the MuleSoft MCP server child process
- Establish an ngrok HTTPS tunnel
- Start the Express server on `127.0.0.1:<PORT>`
- Optionally patch `~/Library/Application Support/Claude/claude_desktop_config.json`
- Print the public URL and connection instructions

## Connecting Claude Desktop

### Option A — Auto-patch (recommended)

Set `UPDATE_CLAUDE_CONFIG=true` in `.env`. The bridge will write the correct `mcpServers` entry on every startup. Restart Claude Desktop after the bridge starts.

### Option B — Manual

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mulesoft": {
      "command": "npx",
      "args": ["mcp-remote", "<PUBLIC_URL>/mcp"]
    }
  }
}
```

Replace `<PUBLIC_URL>` with the ngrok URL printed on startup.

## OAuth 2.1 Flow

The bridge acts as both an **OAuth Authorization Server** and a **Protected Resource**. Authentication is delegated to Anypoint Platform SSO.

```
Claude Desktop          Bridge                    Anypoint Platform
     │                    │                              │
     │── GET /authorize ──▶│                              │
     │   (PKCE S256)       │── redirect to Anypoint ─────▶│
     │                    │   login page                  │
     │◀────────────────────────────────────────────────── │
     │   browser: user logs in with Anypoint credentials  │
     │                    │◀── auth code ─────────────────│
     │                    │    (via claude.ai callback)   │
     │── POST /token ─────▶│                              │
     │   (PKCE verifier +  │── exchange code ────────────▶│
     │    Anypoint code)   │◀── Anypoint access token ────│
     │                    │── GET /accounts/api/me ───────▶│
     │                    │◀── user identity ─────────────│
     │◀── JWT access token─│                              │
     │                    │                              │
     │── POST /mcp ────────▶│  (Bearer JWT)               │
     │   JSON-RPC          │── validate JWT               │
     │                    │── stdin JSON-RPC ──────────▶ mcp-server
     │◀── JSON-RPC resp ───│◀── stdout JSON-RPC ──────── mcp-server
```

### Implemented OAuth endpoints

| Endpoint | RFC | Description |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | Protected Resource Metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Authorization Server Metadata |
| `POST /register` | RFC 7591 | Dynamic Client Registration |
| `GET /authorize` | RFC 6749 / OAuth 2.1 | Authorization endpoint (PKCE S256 required) |
| `POST /token` | RFC 6749 / OAuth 2.1 | Token endpoint |

PKCE `plain` method is rejected; only `S256` is accepted (OAuth 2.1 requirement).

## MCP Proxy

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST /mcp` | | Client → Server JSON-RPC messages |
| `GET /mcp` | | SSE stream for server-initiated notifications |
| `DELETE /mcp` | | Session teardown |

All `/mcp` routes require a valid `Authorization: Bearer <JWT>` header.

Sessions are tracked via the `Mcp-Session-Id` header. A new session ID is created on `initialize` and must be included in all subsequent requests. `GET /mcp` keeps an SSE connection open and forwards notifications from the child process; a heartbeat comment is sent every 15 seconds to keep the connection alive.

### Single-session limitation

The `@mulesoft/mcp-server` child process uses stateful stdio — one process handles all sessions. Only one concurrent `initialize` is supported. A second `initialize` from a different session returns a JSON-RPC `-32603` error.

## Architecture

### Source layout

```
src/
  index.js              — entry point: orchestrates startup and shutdown
  server.js             — Express app factory (CORS, session, routes)
  config.js             — environment variable parsing and validation
  oauth/
    routes.js           — OAuth 2.1 endpoints (discovery, register, authorize, token)
    middleware.js       — requireBearerToken middleware (JWT validation + active-store check)
    jwt.js              — JWT sign/verify (HS256 via jose)
    pkce.js             — PKCE S256 challenge verification
    store.js            — in-memory stores: clients, codes, tokens (with background sweep)
  mcp/
    routes.js           — POST/GET/DELETE /mcp HTTP handlers
    proxy.js            — StdioMcpProxy: child process management + JSON-RPC multiplexing
  tunnel/
    ngrok.js            — ngrok tunnel start/stop
scripts/
  update-claude-config.js — idempotent patch of claude_desktop_config.json
```

### In-memory state

All OAuth state (clients, authorization codes, access tokens) is held in memory. State is lost on restart — clients must re-authenticate. A background timer sweeps expired codes and tokens every 5 minutes.

Token revocation is implicit: the `tokens` Map holds active JTIs. Removing a JTI (or restarting the server) immediately invalidates the corresponding token even if the JWT signature is still valid.

### Security notes

- Tokens are HS256 JWTs signed with `JWT_SECRET`; the secret must be kept confidential
- Session cookies are `Secure`, `HttpOnly`, `SameSite=lax` — valid only over HTTPS (ngrok provides this)
- `app.set('trust proxy', 1)` is set to trust the single ngrok hop so `req.protocol === 'https'` and secure cookies work correctly
- PKCE `plain` is rejected; only `S256` is accepted
- The bridge listens on `127.0.0.1` only — ngrok is the sole public entry point
