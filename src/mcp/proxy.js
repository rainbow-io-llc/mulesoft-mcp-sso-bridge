import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

/**
 * StdioMcpProxy bridges HTTP MCP sessions to the local @mulesoft/mcp-server
 * child process via stdin/stdout JSON-RPC.
 *
 * V1 limitation: a single child process handles all sessions (stateful stdio).
 * A second concurrent `initialize` request will receive a 409 response.
 */
export class StdioMcpProxy extends EventEmitter {
  // Map<sessionId, { pendingRequests: Map<reqId, {resolve, reject}>, initialized: boolean }>
  #sessions = new Map();
  #child = null;
  #lineBuffer = '';
  #activeSessionId = null; // tracks which session has completed `initialize`

  start() {
    const mcpBin = new URL('../../node_modules/.bin/mcp-server', import.meta.url).pathname;

    this.#child = spawn(mcpBin, ['start'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANYPOINT_CLIENT_ID: config.anypoint.clientId,
        ANYPOINT_CLIENT_SECRET: config.anypoint.clientSecret,
        ANYPOINT_REGION: config.anypoint.region,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.#child.stdout.on('data', (chunk) => this.#onData(chunk));

    this.#child.on('error', (err) => {
      console.error('[proxy] child process error:', err);
      this.emit('error', err);
    });

    this.#child.on('exit', (code, signal) => {
      console.error(`[proxy] mcp-server exited (code=${code}, signal=${signal})`);
      this.emit('exit', code);
    });

    console.log('[proxy] mcp-server started');
  }

  stop() {
    if (this.#child) {
      this.#child.kill('SIGTERM');
      this.#child = null;
    }
  }

  #onData(chunk) {
    this.#lineBuffer += chunk.toString('utf8');
    const lines = this.#lineBuffer.split('\n');
    this.#lineBuffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.#dispatch(JSON.parse(trimmed));
      } catch (err) {
        console.error('[proxy] failed to parse stdout line:', trimmed, err);
      }
    }
  }

  #dispatch(message) {
    if ('id' in message && message.id !== null) {
      // It's a response — find which session is waiting for this id
      for (const [, session] of this.#sessions) {
        if (session.pendingRequests.has(message.id)) {
          const { resolve } = session.pendingRequests.get(message.id);
          session.pendingRequests.delete(message.id);
          resolve(message);
          return;
        }
      }
      console.warn('[proxy] received response with unknown id:', message.id);
    } else {
      // Notification (no id or id is null) — broadcast to all SSE streams
      this.emit('notification', message);
    }
  }

  createSession(sessionId) {
    if (this.#sessions.has(sessionId)) return;
    this.#sessions.set(sessionId, {
      pendingRequests: new Map(),
      initialized: false,
    });
  }

  hasSession(sessionId) {
    return this.#sessions.has(sessionId);
  }

  deleteSession(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;

    // Reject any pending requests
    for (const [, { reject }] of session.pendingRequests) {
      reject(new Error('Session deleted'));
    }
    this.#sessions.delete(sessionId);

    if (this.#activeSessionId === sessionId) {
      this.#activeSessionId = null;
    }
    console.log(`[proxy] session deleted: ${sessionId}`);
  }

  /**
   * Forward a JSON-RPC message to the MCP server.
   * @param {string} sessionId
   * @param {object} message - JSON-RPC request
   * @returns {Promise<object>} JSON-RPC response
   */
  async sendRequest(sessionId, message) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    // Enforce single-session limitation on initialize
    if (message.method === 'initialize') {
      if (this.#activeSessionId && this.#activeSessionId !== sessionId) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'Another MCP session is already active. Only one concurrent session is supported.',
          },
        };
      }
      this.#activeSessionId = sessionId;
      session.initialized = true;
    }

    if (!this.#child) {
      throw new Error('MCP server child process is not running');
    }

    return new Promise((resolve, reject) => {
      session.pendingRequests.set(message.id, { resolve, reject });

      const line = JSON.stringify(message) + '\n';
      this.#child.stdin.write(line, (err) => {
        if (err) {
          session.pendingRequests.delete(message.id);
          reject(err);
        }
      });
    });
  }
}
