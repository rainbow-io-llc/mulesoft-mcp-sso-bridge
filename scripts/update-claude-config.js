/**
 * Idempotent script that patches claude_desktop_config.json to add the
 * MuleSoft MCP server via mcp-remote. Safe to run multiple times.
 *
 * Called automatically from src/index.js when UPDATE_CLAUDE_CONFIG=true.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(
  homedir(),
  'Library/Application Support/Claude/claude_desktop_config.json'
);

export function updateClaudeConfig(publicUrl) {
  if (!existsSync(CONFIG_PATH)) {
    console.warn(`[config] Claude Desktop config not found at: ${CONFIG_PATH}`);
    console.warn('[config] Skipping auto-update. Add the mcpServers entry manually.');
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[config] Failed to parse claude_desktop_config.json:', err);
    return;
  }

  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers.mulesoft = {
    command: 'npx',
    args: ['mcp-remote', `${publicUrl}/mcp`],
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`[config] Updated: ${CONFIG_PATH}`);
  console.log('[config] Restart Claude Desktop to load the MuleSoft MCP server.');
}
