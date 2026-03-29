import ngrok from '@ngrok/ngrok';

let _listener = null;

/**
 * Start an ngrok HTTPS tunnel forwarding to the given local port.
 * The @ngrok/ngrok SDK reads the authtoken from:
 *   ~/Library/Application Support/ngrok/ngrok.yml  (macOS)
 *
 * @param {number} port - Local port to tunnel
 * @returns {Promise<string>} Public HTTPS URL (e.g. https://abcd1234.ngrok-free.app)
 */
export async function startTunnel(port) {
  const opts = { addr: port, proto: 'http' };
  if (process.env.NGROK_AUTHTOKEN) {
    opts.authtoken = process.env.NGROK_AUTHTOKEN;
  }
  _listener = await ngrok.forward(opts);

  const url = _listener.url();
  console.log(`[ngrok] Tunnel established: ${url}`);
  return url;
}

/**
 * Disconnect all ngrok tunnels and close the ngrok session.
 */
export async function stopTunnel() {
  try {
    await ngrok.disconnect();
    console.log('[ngrok] Tunnel disconnected');
  } catch (err) {
    console.error('[ngrok] Error disconnecting:', err);
  }
}
