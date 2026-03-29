import 'dotenv/config';
import { config } from './config.js';
import { createApp } from './server.js';
import { StdioMcpProxy } from './mcp/proxy.js';
import { startTunnel, stopTunnel } from './tunnel/ngrok.js';
import { updateClaudeConfig } from '../scripts/update-claude-config.js';

async function main() {
  console.log('[bridge] Starting MuleSoft MCP OAuth Bridge...');

  // ── Step 1: Start MuleSoft MCP server as a child process ─────────────────
  const proxy = new StdioMcpProxy();

  proxy.on('exit', (code) => {
    console.error(`[bridge] Fatal: mcp-server child process exited with code ${code}`);
    process.exit(1);
  });

  proxy.on('error', (err) => {
    console.error('[bridge] Fatal: mcp-server child process error:', err);
    process.exit(1);
  });

  proxy.start();

  // ── Step 2: Start ngrok tunnel ────────────────────────────────────────────
  console.log('[bridge] Connecting ngrok tunnel...');
  let publicUrl;
  try {
    publicUrl = await startTunnel(config.port);
  } catch (err) {
    console.error('[bridge] Failed to start ngrok tunnel:', err.message);
    console.error('[bridge] Make sure your ngrok authtoken is configured:');
    console.error('         ngrok config add-authtoken <your-token>');
    process.exit(1);
  }

  // Inject the public URL into config so OAuth routes return correct URLs
  config.publicUrl = publicUrl;

  // ── Step 3: Start Express server ─────────────────────────────────────────
  const app = createApp(proxy);
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`[bridge] Listening on http://127.0.0.1:${config.port}`);
  });

  // ── Step 4: Update Claude Desktop config ─────────────────────────────────
  if (config.updateClaudeConfig) {
    updateClaudeConfig(publicUrl);
  }

  // ── Step 5: Print connection instructions ────────────────────────────────
  printInstructions(publicUrl);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`\n[bridge] Received ${signal}, shutting down...`);
    server.close();
    proxy.stop();
    await stopTunnel();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printInstructions(publicUrl) {
  const mcpEntry = {
    mcpServers: {
      mulesoft: {
        command: 'npx',
        args: ['mcp-remote', `${publicUrl}/mcp`],
      },
    },
  };

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           MuleSoft MCP Bridge — Ready                        ║
╚══════════════════════════════════════════════════════════════╝

  Public URL   : ${publicUrl}
  MCP endpoint : ${publicUrl}/mcp
  OAuth login  : ${publicUrl}/authorize  (→ Anypoint login page)
  Callback URL : ${publicUrl}/callback   ← Register this in Anypoint!

─────────────────────────────────────────────────────────────────
  ⚠  One-time Anypoint Connected App setup (each ngrok restart)
─────────────────────────────────────────────────────────────────
  1. Go to Anypoint Platform > Access Management > Connected Apps
  2. Open your app (client ID: ${mcpEntry.mcpServers.mulesoft.args[1].split('/')[2].split('.')[0]}...)
  3. Ensure grant types include: authorization_code + client_credentials
  4. Add/update Redirect URI:  ${publicUrl}/callback

─────────────────────────────────────────────────────────────────
  Claude Desktop Connector
─────────────────────────────────────────────────────────────────
  Settings → Connectors → Add MCP Server:
  URL: ${publicUrl}/mcp

  (Or add to claude_desktop_config.json:)
${JSON.stringify(mcpEntry, null, 2)}

─────────────────────────────────────────────────────────────────
  OAuth SSO Flow (first use)
─────────────────────────────────────────────────────────────────
  1. Claude Desktop triggers auth → browser opens Anypoint login
  2. Sign in with your Anypoint Platform credentials
  3. Anypoint redirects back → bridge issues JWT to Claude Desktop
  4. Claude Desktop is now connected to MuleSoft MCP tools

  Press Ctrl+C to stop the bridge.
`);
}

main().catch((err) => {
  console.error('[bridge] Startup failed:', err);
  process.exit(1);
});
