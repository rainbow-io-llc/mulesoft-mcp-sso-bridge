import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { oauthRouter } from './oauth/routes.js';
import { mcpRouter } from './mcp/routes.js';
import { config } from './config.js';

export function createApp(proxy) {
  const app = express();

  // Trust the single ngrok proxy hop so req.protocol === 'https' and
  // secure session cookies work correctly behind the tunnel.
  app.set('trust proxy', 1);

  // CORS — Claude Desktop and mcp-remote send an Origin header.
  // We expose Mcp-Session-Id so clients can read it from responses.
  app.use(cors({
    origin: true,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Accept'],
    exposedHeaders: ['Mcp-Session-Id'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Session (used by OAuth login flow only)
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'mcp_bridge_sid',
    cookie: {
      secure: true,           // HTTPS only (ngrok provides this)
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes (long enough to complete OAuth flow)
    },
  }));

  // Routes
  app.use(oauthRouter());
  app.use(mcpRouter(proxy));

  // Health check
  app.get('/health', (req, res) => res.json({ ok: true }));

  return app;
}
